import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { DocumentObservation, QueueRequest, QueueJob } from "@fmcad/core";
import type { DocumentContinuationBrokerPorts } from "../src/document-continuation-broker";
import type { ParamCheckpointGuardV1 } from "../packages/node-adapters/src/python/cad-script";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "dist/src/queue-broker.js"));
const helper = load(
  "./document-continuation-broker",
) as typeof import("../src/document-continuation-broker");
const { prepareCadScript } = load(
  "./dist/composition/cad",
) as typeof import("../src/composition/cad");
const { pythonArtifactManifest } = load(
  "./dist/python/context-binding",
) as typeof import("../packages/node-adapters/src/python/context-binding");
const { hash } = load(
  "./dist/core/application/cad/json",
) as typeof import("../packages/core/src/application/cad/json");
const { cadWorkerPolicyArguments, decodeCadWorkerInvocation } = load(
  "./dist/core/application/cad/worker-command",
) as typeof import("../packages/core/src/application/cad/worker-command");

const guard: ParamCheckpointGuardV1 = {
  schema: "fmcad.param-checkpoint-v1",
  document: {
    identity: {
      creationId: "creation-A",
      name: "Owned A",
      fileId: "file-A",
      version: 2,
      isSaved: true,
      isModified: false,
    },
    fingerprint: "a".repeat(64),
  },
  parameters: [],
};
function data() {
  return { parameters: [{ name: "length", expression: "12 mm", unit: "mm" }] };
}
function request(): QueueRequest {
  const payload = {
    kind: "cad",
    version: 1,
    operation: "param.apply",
    doc: "Owned A",
    docId: "creation-A",
    docFileId: "file-A",
    data: data(),
  };
  return {
    requestId: "new-write-A",
    clientId: "owner-A",
    ownerToken: "b".repeat(64),
    kind: "command",
    cwd: root,
    timeoutMs: 15000,
    phased: true,
    buildHash: "c".repeat(64),
    payload,
    argv: cadWorkerPolicyArguments(decodeCadWorkerInvocation(payload)),
  };
}

test("offline continuation preparation uses the real default compiler for both ordinary and guarded source", () => {
  const input = request(),
    original = structuredClone(input),
    checkpoint = structuredClone(guard);
  const result = helper.compileDocumentContinuationPrograms(input, checkpoint);
  const context = {
    doc: "Owned A",
    docId: "creation-A",
    docFileId: "file-A",
    preview: false,
  };
  const ordinary = prepareCadScript("param.apply", data(), context);
  const guarded = prepareCadScript(
    "param.apply",
    data(),
    context,
    undefined,
    checkpoint,
  );
  assert.equal(result.ordinary.script, ordinary.script);
  assert.equal(result.guarded.script, guarded.script);
  assert.notEqual(result.ordinary.sourceHash, result.guarded.sourceHash);
  assert.equal(
    result.guarded.sourceHash,
    createHash("sha256").update(guarded.script).digest("hex"),
  );
  assert.deepEqual(result.ordinary.manifest, pythonArtifactManifest(ordinary));
  assert.deepEqual(result.guarded.manifest, pythonArtifactManifest(guarded));
  assert.equal(result.guardDigest, hash(checkpoint));
  assert.equal(result.requestHash, helper.continuationRequestHash(input));
  assert.deepEqual(input, original);
  assert.deepEqual(checkpoint, guard);
  assert.equal("authority" in result, false);
  assert.equal("jobId" in result, false);
});

test("continuation request binding ignores only description, not owner, target, parameters or build", () => {
  const input = request(),
    expected = helper.continuationRequestHash(input);
  assert.equal(
    helper.continuationRequestHash({ ...input, description: "display only" }),
    expected,
  );
  for (const changed of [
    { ...input, ownerToken: "d".repeat(64) },
    { ...input, clientId: "foreign" },
    { ...input, buildHash: "e".repeat(64) },
    { ...input, requestId: "other" },
    { ...input, payload: { ...input.payload, data: { parameters: [] } } },
  ])
    assert.notEqual(helper.continuationRequestHash(changed), expected);
});

test("ordinary policy arguments cannot relabel another document or duplicate the cad prefix", () => {
  const input = request();
  assert.throws(() =>
    helper.compileDocumentContinuationPrograms(
      {
        ...input,
        argv: ["cad", "param", "apply", "--doc-id", "foreign"],
      },
      guard,
    ),
  );
  assert.throws(() =>
    helper.compileDocumentContinuationPrograms(
      {
        ...input,
        argv: ["cad", ...input.argv!],
      },
      guard,
    ),
  );
  const withoutPrefix = helper.compileDocumentContinuationPrograms(
    { ...input, argv: input.argv!.slice(1) },
    guard,
  );
  assert.equal(
    withoutPrefix.guarded.script,
    helper.compileDocumentContinuationPrograms(input, guard).guarded.script,
  );
});

test("only exact typed bounded param.apply may prepare continuation source", () => {
  const input = request();
  for (const payload of [
    { ...input.payload, operation: "param.inspect" },
    { ...input.payload, preview: true },
    { ...input.payload, component: "nested" },
    { ...input.payload, docId: undefined },
  ])
    assert.throws(() =>
      helper.compileDocumentContinuationPrograms(
        {
          ...input,
          payload,
          argv: cadWorkerPolicyArguments(decodeCadWorkerInvocation(payload)),
        },
        guard,
      ),
    );
  assert.throws(() =>
    helper.compileDocumentContinuationPrograms(
      { ...input, kind: "rpc" },
      guard,
    ),
  );
});

test("the full guard is target-bound and client-supplied checkpoint data cannot enter the compiler", () => {
  const input = request();
  assert.throws(() =>
    helper.compileDocumentContinuationPrograms(input, {
      ...guard,
      document: {
        ...guard.document,
        identity: {
          ...guard.document.identity,
          creationId: "foreign",
        },
      },
    }),
  );
  assert.throws(() =>
    helper.compileDocumentContinuationPrograms(
      {
        ...input,
        payload: {
          ...input.payload,
          data: {
            ...(input.payload!["data"] as Record<string, unknown>),
            __fmcad_param_checkpoint: guard,
          },
        },
      },
      guard,
    ),
  );
});

const { QueueDomain } = load(
  "./dist/core/domain/queue",
) as typeof import("../packages/core/src/domain/queue");
const { createTurnIdentity } = load(
  "./dist/core/application/broker-execution",
) as typeof import("../packages/core/src/application/broker-execution");

/** Real core admission/capabilities and default compiler. The required
 * source/native-verifier port is controlled here, not attested as live proof. */
function fixture() {
  let id = 0,
    generation = "generation-A",
    authorized = true,
    sourceValid = true;
  let verifications = 0,
    finalChecks = 0;
  const domain = new QueueDomain({
    now: () => 1000,
    newId: () => `job-${++id}`,
    hash: (value) => createHash("sha256").update(value).digest("hex"),
  });
  const observation: DocumentObservation = {
    version: 1,
    id: "observation-A",
    requestId: "inspect-A",
    actorClientId: "owner-A",
    target: { creationId: "creation-A", fileId: "file-A" },
    generation,
    scope: "parameters",
    stateDigest: hash(guard),
    readback: {
      reference: "private:verified-original",
      sha256: "d".repeat(64),
      probeRequestId: "probe-A",
    },
    blockers: [],
    priorCheckpointId: null,
    createdAt: 1000,
  };
  domain.recordDocumentObservation(observation);
  domain.acceptDocumentObservation({
    observationId: observation.id,
    requestId: "accept-A",
    actorClientId: "owner-A",
    generation,
    observedStateDigest: observation.stateDigest,
  });
  const actor = { clientId: "owner-A", clientTokenHash: "b".repeat(64) };
  const ports: DocumentContinuationBrokerPorts = {
    domain,
    currentGeneration: () => generation,
    recheck(principal, target) {
      assert.equal(principal.clientId, actor.clientId);
      assert.deepEqual(target, observation.target);
      if (!authorized)
        throw Object.assign(new Error("model rights revoked"), {
          code: "EPOCH_CLIENT_NOT_GRANTED",
        });
    },
    async verifyObservation(value, principal) {
      verifications++;
      assert.deepEqual(value, observation);
      assert.equal(principal.clientId, actor.clientId);
      return {
        checkpoint: structuredClone(guard),
        reverify() {
          finalChecks++;
          if (!sourceValid)
            throw Object.assign(new Error("immutable source unavailable"), {
              code: "STORAGE_UNAVAILABLE",
            });
        },
      };
    },
  };
  const broker = helper.createDocumentContinuationBroker(ports);
  function job(result: Record<string, unknown>): QueueJob {
    const jobId = result["id"];
    assert.equal(typeof jobId, "string");
    const value = domain.data.jobs[String(jobId)];
    assert.ok(value);
    return value;
  }
  function call(input = request()): { method: string; args: unknown[] } {
    const original = helper.compileDocumentContinuationPrograms(
      input,
      guard,
    ).ordinary;
    return {
      method: "callTool",
      args: [
        {
          featureType: "script",
          object: { script: original.script, readOnly: false },
        },
        "fusion_mcp_execute",
        original.manifest,
      ],
    };
  }
  return {
    domain,
    actor,
    ports,
    broker,
    job,
    call,
    observation,
    moveHead() {
      const current = domain.documentInspectionFence(
        observation.target,
        generation,
      );
      const next = {
        ...structuredClone(observation),
        id: "observation-new-head",
        requestId: "inspect-new-head",
        priorCheckpointId: current.priorCheckpointId,
      };
      domain.recordDocumentObservation(next);
      domain.acceptDocumentObservation({
        observationId: next.id,
        requestId: "accept-new-head",
        actorClientId: actor.clientId,
        generation,
        observedStateDigest: next.stateDigest,
      });
    },
    generation(value: string) {
      generation = value;
    },
    revoke() {
      authorized = false;
    },
    corruptSource() {
      sourceValid = false;
    },
    counts: () => ({ verifications, finalChecks }),
  };
}

test("real domain capability binds a fresh phased job, verifies the original worker and reauthenticates each new turn", async () => {
  const f = fixture(),
    input = request();
  const job = f.job(await f.broker.submit(input, f.actor));
  assert.equal(job.state, "preparing");
  assert.ok(job.documentContinuation);
  assert.equal(f.counts().verifications, 1);
  const turn = createTurnIdentity(job.id);
  const program = await f.broker.prepareWorker(job, f.call(), turn);
  assert.equal(f.counts().verifications, 2);
  assert.equal(
    f.broker.expectedProduct(job, turn).sourceHash,
    program.sourceHash,
  );
  assert.equal(program.sourceHash, job.documentContinuation.sourceHash);
  Reflect.set(program, "script", "print('caller replaced returned copy')");
  assert.notEqual(
    f.broker.expectedProduct(job, turn).script,
    program.script,
    "returned source is a copy and cannot mutate private expected binding",
  );
  assert.notEqual(
    program.sourceHash,
    helper.compileDocumentContinuationPrograms(input, guard).ordinary
      .sourceHash,
  );
  assert.equal(
    f.domain.data.active,
    null,
    "private code/cap assertion is not an SDK grant",
  );
  assert.throws(
    () => f.domain.markDispatch(job.id),
    "the actual scheduler still owns dispatch",
  );
  f.domain.readyTurn(job.id);
  assert.equal(f.domain.next()?.id, job.id);
  assert.equal(
    f.broker.expectedProduct(f.domain.data.jobs[job.id]!, turn).sourceHash,
    program.sourceHash,
  );
});

test("the real cad-command wrapper and generated policy argv retain the same guarded source contract", async () => {
  const f = fixture(),
    input = request();
  const payload = {
    version: 1,
    kind: "cad-command",
    invocation: input.payload,
    output: { json: true, summary: false },
  };
  const command = {
    ...input,
    payload,
    argv: cadWorkerPolicyArguments(decodeCadWorkerInvocation(payload)),
  };
  const job = f.job(await f.broker.submit(command, f.actor));
  const turn = createTurnIdentity(job.id);
  const program = await f.broker.prepareWorker(job, f.call(command), turn);
  assert.equal(
    program.sourceHash,
    helper.compileDocumentContinuationPrograms(input, guard).guarded.sourceHash,
  );
  assert.equal(job.hash, helper.continuationRequestHash(command));
  assert.notEqual(job.hash, helper.continuationRequestHash(input));
  f.broker.expectedProduct(job, turn);
});

test("a forged worker script, envelope or provenance cannot be replaced with trusted guarded source", async () => {
  for (const variant of ["script", "readonly", "manifest", "method", "extra"]) {
    const f = fixture(),
      job = f.job(await f.broker.submit(request(), f.actor));
    const call = f.call(),
      turn = createTurnIdentity(job.id);
    const envelope = call.args[0];
    assert.ok(envelope && typeof envelope === "object");
    if (variant === "script")
      Reflect.set(envelope, "object", {
        script: "print('foreign')",
        readOnly: false,
      });
    if (variant === "readonly")
      Reflect.set(envelope, "object", {
        script: helper.compileDocumentContinuationPrograms(request(), guard)
          .ordinary.script,
        readOnly: true,
      });
    if (variant === "manifest") call.args[2] = {};
    if (variant === "method") call.method = "executeUiGuardedScript";
    if (variant === "extra") call.args.push("caller-controlled");
    await assert.rejects(f.broker.prepareWorker(job, call, turn), {
      code: "DOCUMENT_CONTINUATION_UNPROVEN",
    });
    assert.equal(
      f.counts().verifications,
      1,
      "a rejected public artifact never reaches fresh native verification",
    );
    assert.throws(() => f.broker.expectedProduct(job, turn));
  }
});

test("only the latest freshly authenticated private job/turn may attest product source", async () => {
  const f = fixture(),
    job = f.job(await f.broker.submit(request(), f.actor));
  const first = createTurnIdentity(job.id),
    second = createTurnIdentity(job.id);
  await f.broker.prepareWorker(job, f.call(), first);
  await assert.rejects(f.broker.prepareWorker(job, f.call(), first));
  await f.broker.prepareWorker(job, f.call(), second);
  assert.equal(f.counts().verifications, 3);
  await assert.rejects(
    f.broker.prepareWorker(job, f.call(), first),
    "an older turn identity cannot be re-armed after another turn was prepared",
  );
  assert.throws(() => f.broker.expectedProduct(job, first));
  assert.throws(() =>
    f.broker.expectedProduct(job, createTurnIdentity(job.id)),
  );
  f.broker.expectedProduct(job, second);
  f.broker.forget(job.id, first);
  f.broker.expectedProduct(job, second);
  f.broker.forget(job.id);
  assert.throws(() => f.broker.expectedProduct(job, second));
});

test("a restarted helper cannot restore authority from the retained JSON marker or acceptance", async () => {
  const f = fixture(),
    job = f.job(await f.broker.submit(request(), f.actor));
  const turn = createTurnIdentity(job.id);
  const reopened = helper.createDocumentContinuationBroker(f.ports);
  await assert.rejects(
    reopened.prepareWorker(structuredClone(job), f.call(), turn),
  );
  assert.throws(() => reopened.expectedProduct(job, turn));
  const other = fixture(),
    otherBroker = helper.createDocumentContinuationBroker(other.ports);
  await assert.rejects(
    otherBroker.prepareWorker(structuredClone(job), f.call(), turn),
  );
  assert.equal(other.domain.data.active, null);
});

test("changed accepted head, generation or source revokes prepared continuation before product binding", async () => {
  for (const change of ["head", "generation", "source"]) {
    const f = fixture(),
      job = f.job(await f.broker.submit(request(), f.actor));
    const turn = createTurnIdentity(job.id);
    await f.broker.prepareWorker(job, f.call(), turn);
    if (change === "generation") f.generation("generation-B");
    if (change === "source") f.corruptSource();
    if (change === "head") {
      f.moveHead();
    }
    assert.throws(() => f.broker.expectedProduct(job, turn));
    assert.equal(f.domain.data.active, null);
  }
});

test("revoked modeling rights expire only the queued job, while source/storage errors propagate", async () => {
  const { phased, ...nonphased } = request();
  void phased;
  const revoked = fixture(),
    job = revoked.job(await revoked.broker.submit(nonphased, revoked.actor));
  revoked.revoke();
  assert.equal(revoked.domain.next(), null);
  assert.equal(revoked.domain.data.jobs[job.id]?.state, "failed");
  assert.equal(revoked.domain.data.jobs[job.id]?.code, "CHECKPOINT_CHANGED");
  const corrupt = fixture();
  await corrupt.broker.submit(nonphased, corrupt.actor);
  corrupt.corruptSource();
  assert.throws(() => corrupt.domain.next(), { code: "STORAGE_UNAVAILABLE" });
});

test("final synchronous verification after the last await prevents head/rights/source races from enqueuing", async () => {
  for (const change of ["head", "rights", "source"]) {
    const f = fixture(),
      original = f.ports.verifyObservation;
    f.ports.verifyObservation = async (observation, actor) => {
      const proof = await original(observation, actor);
      if (change === "rights") f.revoke();
      if (change === "source") f.corruptSource();
      if (change === "head") {
        f.moveHead();
      }
      return proof;
    };
    await assert.rejects(f.broker.submit(request(), f.actor));
    assert.equal(Object.keys(f.domain.data.jobs).length, 0);
  }
});

test("duplicate retained requests do not re-arm an expired continuation or replace its private source entry", async () => {
  const f = fixture(),
    input = request();
  const first = f.job(await f.broker.submit(input, f.actor));
  const turn = createTurnIdentity(first.id);
  await f.broker.prepareWorker(first, f.call(), turn);
  f.broker.forget(first.id);
  const repeated = f.job(await f.broker.submit(input, f.actor));
  assert.equal(repeated.id, first.id);
  assert.throws(() => f.broker.expectedProduct(repeated, turn));
  await assert.rejects(
    f.broker.prepareWorker(repeated, f.call(), createTurnIdentity(first.id)),
  );
  assert.equal(Object.keys(f.domain.data.jobs).length, 1);
  f.domain.readyTurn(first.id);
  assert.equal(f.domain.next(), null);
  assert.equal(f.domain.data.jobs[first.id]?.state, "failed");
  assert.equal(f.domain.data.jobs[first.id]?.code, "CHECKPOINT_CHANGED");
});

test("concurrent preparation cannot re-use a turn identity and a failed verification never arms it", async () => {
  const f = fixture(),
    job = f.job(await f.broker.submit(request(), f.actor));
  const turn = createTurnIdentity(job.id);
  const results = await Promise.allSettled([
    f.broker.prepareWorker(job, f.call(), turn),
    f.broker.prepareWorker(job, f.call(), turn),
  ]);
  assert.equal(
    results.filter((value) => value.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((value) => value.status === "rejected").length,
    1,
  );
  const failed = createTurnIdentity(job.id);
  f.ports.verifyObservation = async () => {
    throw Object.assign(new Error("missing native history"), {
      code: "STORAGE_UNAVAILABLE",
    });
  };
  await assert.rejects(f.broker.prepareWorker(job, f.call(), failed), {
    code: "STORAGE_UNAVAILABLE",
  });
  assert.throws(() => f.broker.expectedProduct(job, failed));
  await assert.rejects(f.broker.prepareWorker(job, f.call(), failed));
});

test("terminal continuation sweep invalidates pending preparation without granting a late result", async () => {
  const f = fixture(),
    job = f.job(await f.broker.submit(request(), f.actor)),
    turn = createTurnIdentity(job.id);
  const original = f.ports.verifyObservation;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  f.ports.verifyObservation = async (observation, actor) => {
    await waiting;
    return original(observation, actor);
  };
  const preparation = f.broker.prepareWorker(job, f.call(), turn);
  f.broker.prune(() => ({ state: "cancelled" }));
  release();
  await assert.rejects(preparation, { code: "DOCUMENT_CONTINUATION_UNPROVEN" });
  assert.throws(() => f.broker.expectedProduct(job, turn));
  assert.equal(f.domain.data.jobs[job.id]?.state, job.state,
    "local cleanup neither changes durable queue state nor settles an SDK turn");
});

test("required source verification cannot be replaced by booleans, asynchronous final checks or default authority", async () => {
  for (const variant of [
    "boolean",
    "async-final",
    "async-rights",
    "async-generation",
  ]) {
    const f = fixture(),
      original = f.ports.verifyObservation;
    if (variant === "boolean")
      Reflect.set(f.ports, "verifyObservation", async () => true);
    if (variant === "async-final")
      f.ports.verifyObservation = async (observation, actor) => ({
        ...(await original(observation, actor)),
        reverify: async () => {
          throw new Error("a final native verifier may not return a promise");
        },
      });
    if (variant === "async-rights")
      Reflect.set(f.ports, "recheck", async () => {
        throw new Error("not a synchronous authority");
      });
    if (variant === "async-generation")
      Reflect.set(f.ports, "currentGeneration", async () => {
        throw new Error("not a synchronous generation");
      });
    await assert.rejects(f.broker.submit(request(), f.actor));
    assert.equal(Object.keys(f.domain.data.jobs).length, 0);
  }
});

test("unrelated owner/root/storage errors are not rewritten into per-job authorization expiry", async () => {
  const f = fixture(),
    { phased, ...input } = request();
  void phased;
  await f.broker.submit(input, f.actor);
  f.ports.recheck = () => {
    throw Object.assign(new Error("root ownership changed"), {
      code: "STORAGE_UNAVAILABLE",
    });
  };
  assert.throws(() => f.domain.next(), { code: "STORAGE_UNAVAILABLE" });
  assert.equal(Object.values(f.domain.data.jobs)[0]?.state, "queued");
});

test("stale generation and head are per-job refusal, not an exception that stops unrelated queue selection", async () => {
  for (const change of ["generation", "head"]) {
    const f = fixture(),
      { phased, ...input } = request();
    void phased;
    const job = f.job(await f.broker.submit(input, f.actor));
    if (change === "generation") f.generation("generation-B");
    else {
      f.moveHead();
    }
    assert.equal(f.domain.next(), null);
    assert.equal(f.domain.data.jobs[job.id]?.state, "failed");
    assert.equal(f.domain.data.jobs[job.id]?.code, "CHECKPOINT_CHANGED");
  }
});

for (const newerFails of [false, true]) {
  test(`an older pending prepare cannot supersede a newer ${newerFails ? "failed" : "successful"} attempt`, async () => {
    const f = fixture(),
      job = f.job(await f.broker.submit(request(), f.actor));
    const original = f.ports.verifyObservation;
    let releaseOlder!: () => void,
      markStarted!: () => void,
      calls = 0;
    const waiting = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    f.ports.verifyObservation = async (observation, actor) => {
      const ordinal = ++calls;
      const proof = await original(observation, actor);
      if (ordinal === 1) {
        markStarted();
        await waiting;
      } else if (ordinal === 2 && newerFails) {
        throw Object.assign(new Error("newer native verification failed"), {
          code: "STORAGE_UNAVAILABLE",
        });
      }
      return proof;
    };
    const olderTurn = createTurnIdentity(job.id),
      newerTurn = createTurnIdentity(job.id);
    const older = f.broker.prepareWorker(job, f.call(), olderTurn);
    await started;
    if (newerFails) {
      await assert.rejects(f.broker.prepareWorker(job, f.call(), newerTurn), {
        code: "STORAGE_UNAVAILABLE",
      });
      assert.throws(() => f.broker.expectedProduct(job, newerTurn));
    } else {
      await f.broker.prepareWorker(job, f.call(), newerTurn);
      f.broker.expectedProduct(job, newerTurn);
    }
    releaseOlder();
    await assert.rejects(older, { code: "DOCUMENT_CONTINUATION_UNPROVEN" });
    assert.throws(() => f.broker.expectedProduct(job, olderTurn));
    if (!newerFails) f.broker.expectedProduct(job, newerTurn);
    else {
      f.ports.verifyObservation = original;
      const fresh = createTurnIdentity(job.id);
      await f.broker.prepareWorker(job, f.call(), fresh);
      f.broker.expectedProduct(job, fresh);
    }
    assert.equal(
      f.domain.data.active,
      null,
      "neither verification grants an SDK lane",
    );
  });
}

test("submission preparation has a private synchronous commit API for the existing project fence", () => {
  const f = fixture();
  assert.equal(
    typeof Reflect.get(f.broker, "prepareSubmit"),
    "function",
    "async source verification must be separated from synchronous domain admission",
  );
});

test("prepareSubmit creates no job and its one-shot commit is synchronous without another native verification", async () => {
  const f = fixture(),
    input = request(),
    original = structuredClone(input);
  const principal = { ...f.actor };
  const prepared = await f.broker.prepareSubmit(input, principal);
  assert.deepEqual(Object.keys(f.domain.data.jobs), []);
  assert.equal(f.counts().verifications, 1);
  assert.deepEqual(Object.keys(prepared), ["submit"]);
  assert.equal(
    JSON.stringify(prepared),
    "{}",
    "serialized data cannot recreate the private closure",
  );
  input.clientId = "foreign";
  principal.clientId = "foreign";
  const before = f.counts().finalChecks;
  const result = prepared.submit();
  assert.equal(result instanceof Promise, false);
  const job = f.job(result);
  assert.equal(job.hash, helper.continuationRequestHash(original));
  assert.equal(job.clientId, f.actor.clientId);
  assert.equal(f.counts().verifications, 1);
  assert.ok(f.counts().finalChecks > before);
  assert.throws(() => prepared.submit(), {
    code: "DOCUMENT_CONTINUATION_UNPROVEN",
  });
  assert.equal(Object.keys(f.domain.data.jobs).length, 1);
});

test("prepared commit rechecks current head, rights, generation and source after the preparation await", async () => {
  for (const change of ["head", "rights", "generation", "source"]) {
    const f = fixture();
    const prepared = await f.broker.prepareSubmit(request(), f.actor);
    if (change === "head") f.moveHead();
    if (change === "rights") f.revoke();
    if (change === "generation") f.generation("generation-B");
    if (change === "source") f.corruptSource();
    assert.throws(() => prepared.submit());
    assert.equal(Object.keys(f.domain.data.jobs).length, 0);
    assert.equal(f.counts().verifications, 1);
    assert.throws(
      () => prepared.submit(),
      { code: "DOCUMENT_CONTINUATION_UNPROVEN" },
      "a refused commit cannot be silently retried with cached authority",
    );
  }
});

test("two prepared closures for a retained request cannot re-arm its private job entry", async () => {
  const f = fixture(),
    input = request();
  const [older, newer] = await Promise.all([
    f.broker.prepareSubmit(input, f.actor),
    f.broker.prepareSubmit(input, f.actor),
  ]);
  const job = f.job(newer.submit());
  f.broker.forget(job.id);
  assert.equal(f.job(older.submit()).id, job.id);
  await assert.rejects(
    f.broker.prepareWorker(job, f.call(), createTurnIdentity(job.id)),
  );
  f.domain.readyTurn(job.id);
  assert.equal(f.domain.next(), null);
  assert.equal(f.domain.data.jobs[job.id]?.code, "CHECKPOINT_CHANGED");
});

test("prepared admission executes inside the real synchronous project-activity fence", async (t) => {
  const directory = fs.mkdtempSync("/tmp/opencode/continuation-project-fence-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { openProjectRegistry } = load(
    "./dist/node-adapters/persistence/project-history/registry",
  ) as typeof import("../packages/node-adapters/src/persistence/project-history/registry");
  const { registerProjectHistoryStore } = load(
    "./dist/node-adapters/persistence/project-history/sqlite",
  ) as typeof import("../packages/node-adapters/src/persistence/project-history/sqlite");
  const { withProjectActivityFence } = load(
    "./dist/node-adapters/persistence/project-history/activity",
  ) as typeof import("../packages/node-adapters/src/persistence/project-history/activity");
  const registry = openProjectRegistry({
    filePath: path.join(directory, "registry.json"),
  });
  const projectRoot = path.join(directory, "project");
  fs.mkdirSync(projectRoot);
  const store = registerProjectHistoryStore(registry, {
    projectRoot,
    projectId: "owned-project",
  });
  store.close();
  const f = fixture(),
    verify = f.ports.verifyObservation;
  let insideFence = false;
  f.ports.verifyObservation = async (observation, actor) => {
    assert.equal(
      insideFence,
      false,
      "native/source awaits must precede the registry/SQLite fence",
    );
    return verify(observation, actor);
  };
  const prepared = await f.broker.prepareSubmit(
    { ...request(), cwd: projectRoot },
    f.actor,
  );
  const accepted = withProjectActivityFence(
    projectRoot,
    () => {
      insideFence = true;
      try {
        assert.equal(Object.keys(f.domain.data.jobs).length, 0);
        return prepared.submit();
      } finally {
        insideFence = false;
      }
    },
    { registry },
  );
  assert.equal(accepted instanceof Promise, false);
  assert.equal(f.job(accepted).state, "preparing");
  assert.equal(f.counts().verifications, 1);
  assert.equal(fs.existsSync(registry.readonlyPath + ".lock"), false);
  const waiting = await f.broker.prepareSubmit(
    {
      ...request(),
      requestId: "prepared-before-project-archive",
      cwd: projectRoot,
    },
    f.actor,
  );
  const registered = registry.lookup("owned-project");
  assert.ok(registered);
  const now = Date.now();
  registry.register({
    projectId: registered.projectId,
    projectPath: registered.path,
    databaseId: registered.databaseId,
    monitoring: false,
    archivedAtMs: now,
    nowMs: now,
  });
  assert.throws(
    () =>
      withProjectActivityFence(projectRoot, () => waiting.submit(), {
        registry,
      }),
    { code: "PROJECT_ACTIVITY_BLOCKED" },
  );
  assert.equal(
    Object.keys(f.domain.data.jobs).length,
    1,
    "archiving after preparation prevents admission before the closure is called",
  );
});
