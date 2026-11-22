import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import type {
  RuntimeBarrierBinding,
  RuntimeRebaselineAuthorityPorts,
} from "../src/queue-runtime-rebaseline";
const {
  literalRuntimeHead,
  rebaselineRuntime,
  runtimeRebaselineRoot,
  createRuntimeRebaselineAuthority,
  assertNoPendingRuntimePublication,
} = createRequire(path.join(process.cwd(), "src/queue-broker.js"))(
  "./queue-runtime-rebaseline",
) as typeof import("../src/queue-runtime-rebaseline");
const { durable, syncDirectory } = createRequire(
  path.join(process.cwd(), "src/queue-broker.js"),
)(
  "./dist/node-adapters/persistence/records",
) as typeof import("../packages/node-adapters/src/persistence/records");

const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-rebaseline-"));
  const state = {
    version: 1,
    jobs: {
      unknown: { id: "unknown", state: "unknown", request: { kind: "run" } },
      queued: { id: "queued", state: "queued", request: { kind: "command" } },
      done: { id: "done", state: "succeeded" },
    },
    quarantined: { unknown: { target: null } },
    lease: { clientId: "vanished" },
  };
  fs.writeFileSync(path.join(dir, "queue-state.json"), JSON.stringify(state));
  fs.writeFileSync(
    path.join(dir, "physical-backend-head.json"),
    '{"unproven":"68221-caf14"}',
  );
  const pins = {
    handoffId: "handoff-1",
    admissionStore: "host/admission.sqlite3",
    generation: { epoch: "new-epoch", instance: "new-instance" },
    process: { pid: 41244, birth: "134398159552332522" },
    source: "a".repeat(40),
    build: "b".repeat(64),
    endpoint: "http://127.0.0.1:8765/mcp",
  };
  const proofFile = path.join(dir, "host-proof.json");
  const current: RuntimeBarrierBinding = {
    ...pins,
    retiredProcess: { pid: 36828, birth: "old-birth" },
    retirement: "process_dead",
    ingress: "pinned_all_sdk_ingress",
    grantCount: 0,
    admissionCount: 0,
    writerGeneration: "exclusive-writer",
  };
  fs.writeFileSync(proofFile, JSON.stringify(current));
  const proof = { path: proofFile, sha256: digest(fs.readFileSync(proofFile)) };
  let lock = true,
    reads = 0;
  let beforePublish = () => {};
  let afterConsume = () => {},
    casCount = 0,
    consumeCount = 0;
  const authorityFor = (operatorId = "local-operator") =>
    createRuntimeRebaselineAuthority({
      store: dir,
      operatorId,
      pins,
      async withExclusiveBarrier(request, work) {
        const beginFile = path.join(dir, "native-begin.json");
        if (!fs.existsSync(beginFile))
          durable(beginFile, { request, initiatorOperatorId: operatorId });
        const begin = JSON.parse(fs.readFileSync(beginFile, "utf8"));
        assert.deepEqual(begin.request, request);
        return work({
          initiatorOperatorId: begin.initiatorOperatorId,
          assertWriterAndProvisionLock() {
            assert.ok(lock, "writer/provision lock lost");
          },
          async verifyCurrentBarrier() {
            reads++;
            return { binding: current, evidence: [proof] };
          },
          async publishActivation(publication) {
            beforePublish();
            assert.ok(lock, "publication authority lost its lock");
            assert.equal(current.grantCount, 0);
            assert.equal(current.admissionCount, 0);
            assert.equal(
              digest(fs.readFileSync(publication.record.path)),
              publication.record.sha256,
            );
            const marker = path.join(
              dir,
              "runtime-rebaseline-publication.json",
            );
            if (!fs.existsSync(marker))
              durable(marker, {
                requestId: request.requestId,
                expectedHead: request.expectedHead,
                nativeProcess: { pid: 123, birth: "owned-fixture" },
                nonce: "owned-fixture",
              });
            const exactNew =
              fs.existsSync(publication.activationFile) &&
              fs.readFileSync(publication.activationFile, "utf8") ===
                publication.activationBytes;
            if (!exactNew) {
              assert.equal(
                literalRuntimeHead(dir).digest,
                publication.expectedHead,
              );
              durable(
                publication.activationFile,
                JSON.parse(publication.activationBytes),
              );
              casCount++;
            } else {
              for (const [name, expected] of Object.entries(
                publication.expectedFiles,
              )) {
                if (name === "runtime-rebaseline-head.json") continue;
                const file = path.join(dir, name);
                assert.equal(
                  fs.existsSync(file) ? digest(fs.readFileSync(file)) : null,
                  expected,
                  "canonical state changed",
                );
              }
              const frozen = JSON.parse(
                fs.readFileSync(publication.record.path, "utf8"),
              ).frozen;
              for (const file of [
                publication.record.path,
                publication.activationFile,
                ...Object.values(frozen)
                  .filter(Boolean)
                  .map((value) => (value as { path: string }).path),
              ]) {
                const fd = fs.openSync(file, "r");
                try {
                  fs.fsyncSync(fd);
                } finally {
                  fs.closeSync(fd);
                }
                syncDirectory(path.dirname(file));
              }
            }
          },
          async consumeActivation(publication) {
            assert.ok(lock, "consume authority lost writer lock");
            const binding = {
              requestId: request.requestId,
              newHead: JSON.parse(publication.activationBytes).newHead,
              publicationDigest: digest(JSON.stringify(publication)),
              initiatorOperatorId: begin.initiatorOperatorId,
            };
            const file = path.join(dir, "native-consumed.json");
            if (!fs.existsSync(file)) {
              durable(file, binding, true);
              consumeCount++;
            }
            assert.deepEqual(
              JSON.parse(fs.readFileSync(file, "utf8")),
              binding,
            );
            afterConsume();
            const marker = path.join(
              dir,
              "runtime-rebaseline-publication.json",
            );
            if (fs.existsSync(marker)) {
              fs.unlinkSync(marker);
              syncDirectory(dir);
            }
            return {
              binding,
              evidence: [{ path: file, sha256: digest(fs.readFileSync(file)) }],
            };
          },
        });
      },
    } satisfies RuntimeRebaselineAuthorityPorts);
  const authority = authorityFor();
  const request = () => ({
    requestId: "rebaseline-1",
    handoffId: pins.handoffId,
    expectedHead: literalRuntimeHead(dir).digest,
  });
  return {
    dir,
    state,
    pins,
    proof,
    current,
    authority,
    authorityFor,
    request,
    unlock: () => {
      lock = false;
    },
    reads: () => reads,
    beforePublish: (hook: () => void) => {
      beforePublish = hook;
    },
    afterConsume: (hook: () => void) => {
      afterConsume = hook;
    },
    counts: () => ({ cas: casCount, consume: consumeCount }),
  };
}

test("literal preflight and new root preserve unproven history and freeze all old work", async () => {
  const f = fixture();
  assert.equal(Object.hasOwn(literalRuntimeHead(f.dir), "files"), false);
  const before = fs.readFileSync(path.join(f.dir, "queue-state.json"));
  const receipt = await rebaselineRuntime(f.dir, f.request(), f.authority);
  assert.equal(receipt.history, "preserved_unproven");
  assert.equal(receipt.grantIssued, false);
  assert.equal(receipt.sdkSubmitted, false);
  assert.deepEqual(
    fs.readFileSync(path.join(f.dir, "queue-state.json")),
    before,
  );
  const root = runtimeRebaselineRoot(f.dir)!;
  assert.equal(root.record.dispositions["unknown"]?.outcome, "unknown");
  assert.equal(root.record.dispositions["queued"]?.outcome, "not_started");
  assert.equal(
    root.record.dispositions["unknown"]?.executionFence.kind,
    "runtime_retired",
  );
  assert.deepEqual(root.snapshot, f.state);
  assert.equal(root.record.history, "preserved_unproven");
  assert.deepEqual(root.record.carriedExposures, f.state.quarantined);
});

test("retry after publication resumes native consume before returning success without a second CAS", async () => {
  const f = fixture(),
    request = f.request();
  await assert.rejects(
    rebaselineRuntime(f.dir, request, f.authority, {
      fault(point) {
        if (point === "after_activation") throw Error("crash");
      },
    }),
    /crash/,
  );
  assert.throws(() => runtimeRebaselineRoot(f.dir), {
    code: "RUNTIME_ACTIVATION_INCOMPLETE",
  });
  assert.deepEqual(f.counts(), { cas: 1, consume: 0 });
  const reads = f.reads();
  const receipt = await rebaselineRuntime(
    f.dir,
    request,
    f.authorityFor("successor"),
  );
  assert.deepEqual(receipt, runtimeRebaselineRoot(f.dir)!.record.receipt);
  assert.equal(f.reads(), reads);
  assert.deepEqual(f.counts(), { cas: 1, consume: 1 });
  assert.equal(
    runtimeRebaselineRoot(f.dir)!.record.operatorId,
    "local-operator",
  );
  f.unlock();
  assert.deepEqual(
    await rebaselineRuntime(f.dir, request, f.authority),
    receipt,
  );
  assert.equal(f.reads(), reads);
  await assert.rejects(
    rebaselineRuntime(f.dir, { ...request, handoffId: "other" }, f.authority),
    { code: "REQUEST_CONFLICT" },
  );
});

test("crash before CAS leaves old activation and permits same-ID retry", async () => {
  const f = fixture(),
    request = f.request();
  await assert.rejects(
    rebaselineRuntime(f.dir, request, f.authority, {
      fault(point) {
        if (point === "before_activation") throw Error("crash");
      },
    }),
    /crash/,
  );
  assert.equal(runtimeRebaselineRoot(f.dir), null);
  assert.equal(literalRuntimeHead(f.dir).digest, request.expectedHead);
  await rebaselineRuntime(
    f.dir,
    request,
    f.authorityFor("successor-before-cas"),
  );
  assert.equal(
    runtimeRebaselineRoot(f.dir)!.record.operatorId,
    "local-operator",
  );
});

test("lost consume ACK resumes the durable terminal receipt under a different operator", async () => {
  const f = fixture(),
    request = f.request();
  f.afterConsume(() => {
    throw Error("consume ACK lost");
  });
  await assert.rejects(
    rebaselineRuntime(f.dir, request, f.authority),
    /consume ACK lost/,
  );
  assert.deepEqual(f.counts(), { cas: 1, consume: 1 });
  assert.throws(() => runtimeRebaselineRoot(f.dir), {
    code: "RUNTIME_ACTIVATION_INCOMPLETE",
  });
  f.afterConsume(() => {});
  const receipt = await rebaselineRuntime(
    f.dir,
    request,
    f.authorityFor("different-operator"),
  );
  assert.equal(receipt.rebaselineId, request.requestId);
  assert.deepEqual(f.counts(), { cas: 1, consume: 1 });
  assert.equal(
    runtimeRebaselineRoot(f.dir)!.record.operatorId,
    "local-operator",
  );
  assert.equal(
    fs.existsSync(path.join(f.dir, "runtime-rebaseline-publication.json")),
    false,
  );
});

test("published head without native consume cannot authorize bootstrap or survive a conflicting head", async () => {
  const f = fixture(),
    request = f.request();
  await assert.rejects(
    rebaselineRuntime(f.dir, request, f.authority, {
      fault(point) {
        if (point === "after_activation") throw Error("stop before consume");
      },
    }),
    /stop before consume/,
  );
  const file = path.join(f.dir, "queue-state.json");
  fs.appendFileSync(file, " ");
  // An exact NEW activation must recheck the frozen canonical state, not merely
  // find the pointer and forge a completion after another writer changed it.
  await assert.rejects(
    rebaselineRuntime(f.dir, request, f.authorityFor("resumer")),
    /canonical state changed/,
  );
  assert.deepEqual(f.counts(), { cas: 1, consume: 0 });
  assert.throws(() => runtimeRebaselineRoot(f.dir), {
    code: "RUNTIME_ACTIVATION_INCOMPLETE",
  });
});

test("native consume byte provenance is required before completion is published", async () => {
  const f = fixture();
  f.afterConsume(() => {
    fs.writeFileSync(
      path.join(f.dir, "native-consumed.json"),
      '{"requestId":"substituted"}',
    );
  });
  await assert.rejects(rebaselineRuntime(f.dir, f.request(), f.authority), {
    code: "RUNTIME_ACTIVATION_INCOMPLETE",
  });
  assert.throws(() => runtimeRebaselineRoot(f.dir), {
    code: "RUNTIME_ACTIVATION_INCOMPLETE",
  });
});

test("changed head, copied store and lost lock fail before activation", async () => {
  for (const mutation of ["head", "store", "lock"]) {
    const f = fixture(),
      request = f.request();
    if (mutation === "head")
      fs.appendFileSync(path.join(f.dir, "queue-state.json"), " ");
    if (mutation === "lock") f.unlock();
    const target =
      mutation === "store"
        ? fs.mkdtempSync(path.join(os.tmpdir(), "foreign-store-"))
        : f.dir;
    await assert.rejects(rebaselineRuntime(target, request, f.authority));
    assert.equal(runtimeRebaselineRoot(f.dir), null);
  }
});

test("host PID birth, grant, admissions and evidence substitution fail closed", async () => {
  for (const mutation of ["birth", "grant", "admission", "proof"]) {
    const f = fixture(),
      request = f.request();
    if (mutation === "birth") f.current.process.birth = "reused-pid";
    if (mutation === "grant") Object.assign(f.current, { grantCount: 1 });
    if (mutation === "admission")
      Object.assign(f.current, { admissionCount: 1 });
    if (mutation === "proof") fs.appendFileSync(f.proof.path, " ");
    await assert.rejects(rebaselineRuntime(f.dir, request, f.authority));
    assert.equal(runtimeRebaselineRoot(f.dir), null);
  }
});

test("store and host are rechecked after staging immediately before CAS", async () => {
  for (const mutation of ["store", "grant", "lock"]) {
    const f = fixture(),
      request = f.request();
    await assert.rejects(
      rebaselineRuntime(f.dir, request, f.authority, {
        fault(point) {
          if (point !== "after_staging") return;
          if (mutation === "store")
            fs.appendFileSync(path.join(f.dir, "queue-state.json"), " ");
          if (mutation === "grant") Object.assign(f.current, { grantCount: 1 });
          if (mutation === "lock") f.unlock();
        },
      }),
    );
    assert.equal(runtimeRebaselineRoot(f.dir), null);
  }
});

test("modeling inputs and forged capability cannot grant local operator authority", async () => {
  const f = fixture(),
    request = f.request();
  await assert.rejects(
    rebaselineRuntime(
      f.dir,
      request,
      {} as Parameters<typeof rebaselineRuntime>[2],
    ),
    { code: "NOT_AUTHORIZED" },
  );
  await assert.rejects(
    rebaselineRuntime(
      f.dir,
      { ...request, force: true } as typeof request,
      f.authority,
    ),
    { code: "INVALID_REQUEST" },
  );
  assert.equal(runtimeRebaselineRoot(f.dir), null);
});

test("source, handoff, generation, admission store and endpoint substitutions are rejected", async () => {
  for (const key of [
    "source",
    "build",
    "handoffId",
    "admissionStore",
    "endpoint",
  ] as const) {
    const f = fixture(),
      request = f.request();
    f.current[key] = "substituted";
    await assert.rejects(rebaselineRuntime(f.dir, request, f.authority), {
      code: "RUNTIME_BARRIER_UNPROVEN",
    });
    assert.equal(runtimeRebaselineRoot(f.dir), null);
  }
  const f = fixture();
  f.current.generation.instance = "wrong-generation";
  await assert.rejects(rebaselineRuntime(f.dir, f.request(), f.authority));
});

test("UNKNOWN without a known target and local/control uncertainty remain global", async () => {
  const f = fixture();
  const file = path.join(f.dir, "queue-state.json");
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  snapshot.quarantined = {};
  snapshot.localUnknown = { requestId: "old-local" };
  snapshot.controlBlocked = { requestId: "old-control" };
  snapshot.jobs.queued.dispatch = { rpcCount: 1 };
  fs.writeFileSync(file, JSON.stringify(snapshot));
  const receipt = await rebaselineRuntime(f.dir, f.request(), f.authority);
  const root = runtimeRebaselineRoot(f.dir)!;
  assert.equal(receipt.carriedExposures, 4);
  for (const value of Object.values(root.record.carriedExposures))
    assert.equal((value as { target: unknown }).target, null);
  assert.equal(root.record.dispositions["queued"]?.outcome, "unknown");
  assert.deepEqual(root.snapshot["lease"], snapshot.lease);
  // The old lease is evidence only; no new runnable snapshot or lease is emitted.
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify(snapshot));
});

test("started queued work and existing exposure keys cannot be mislabeled or overwritten", async () => {
  const f = fixture(),
    file = path.join(f.dir, "queue-state.json");
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  snapshot.quarantined = {
    "runtime:queued": { jobId: "previous", target: null },
  };
  snapshot.jobs.queued.startedAt = 0;
  fs.writeFileSync(file, JSON.stringify(snapshot));
  await rebaselineRuntime(f.dir, f.request(), f.authority);
  const root = runtimeRebaselineRoot(f.dir)!;
  assert.equal(root.record.dispositions["queued"]?.outcome, "unknown");
  assert.deepEqual(
    root.record.carriedExposures["runtime:queued"],
    snapshot.quarantined["runtime:queued"],
  );
  assert.equal(Object.keys(root.record.carriedExposures).length, 3);
  assert.equal(
    (root.record.carriedExposures["runtime:queued:"] as { jobId: string })
      .jobId,
    "queued",
  );
});

test("frozen snapshot tamper is not converted into an empty or ordinary root", async () => {
  const f = fixture();
  await rebaselineRuntime(f.dir, f.request(), f.authority);
  const root = runtimeRebaselineRoot(f.dir)!;
  fs.appendFileSync(root.record.frozen["queue-state.json"]!.path, " ");
  assert.throws(() => runtimeRebaselineRoot(f.dir), {
    code: "RUNTIME_BARRIER_CHANGED",
  });
});

test("ordinary root does not resolve the impossible historical bridge again", async () => {
  const f = fixture();
  await rebaselineRuntime(f.dir, f.request(), f.authority);
  // The historical pointer is frozen exact bytes, not authenticated as passed.
  const root = runtimeRebaselineRoot(f.dir)!;
  assert.equal(
    fs.readFileSync(
      root.record.frozen["physical-backend-head.json"]!.path,
      "utf8",
    ),
    '{"unproven":"68221-caf14"}',
  );
  assert.equal(root.record.history, "preserved_unproven");
  assert.equal(
    root.record.binding.generation.instance,
    f.pins.generation.instance,
  );
});

test("symlink destination is refused before writing foreign evidence", async () => {
  const f = fixture(),
    foreign = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-rebaseline-"));
  fs.mkdirSync(path.join(f.dir, "runtime-rebaselines"));
  fs.symlinkSync(
    foreign,
    path.join(f.dir, "runtime-rebaselines", "rebaseline-1"),
  );
  await assert.rejects(rebaselineRuntime(f.dir, f.request(), f.authority), {
    code: "STORAGE_UNAVAILABLE",
  });
  assert.deepEqual(fs.readdirSync(foreign), []);
  assert.equal(runtimeRebaselineRoot(f.dir), null);
});

test("loss at the publication authority after the parent precheck cannot publish", async () => {
  for (const change of ["lock", "grant", "store"]) {
    const f = fixture();
    f.beforePublish(() => {
      if (change === "lock") f.unlock();
      if (change === "grant") Object.assign(f.current, { grantCount: 1 });
      if (change === "store")
        fs.appendFileSync(path.join(f.dir, "queue-state.json"), " ");
    });
    await assert.rejects(rebaselineRuntime(f.dir, f.request(), f.authority));
    assert.equal(runtimeRebaselineRoot(f.dir), null);
  }
});

test("native publisher reservation survives parent death and blocks new activation", async () => {
  const f = fixture(),
    request = f.request();
  fs.writeFileSync(
    path.join(f.dir, "runtime-rebaseline-publication.json"),
    '{"nativeProcess":{"pid":123,"birth":"still-live"},"parentDead":true}',
  );
  assert.throws(() => assertNoPendingRuntimePublication(f.dir), {
    code: "RUNTIME_PUBLICATION_PENDING",
  });
  await assert.rejects(rebaselineRuntime(f.dir, request, f.authority), {
    code: "RUNTIME_PUBLICATION_PENDING",
  });
  assert.equal(f.reads(), 0);
  assert.equal(runtimeRebaselineRoot(f.dir), null);
  assert.ok(
    fs.existsSync(path.join(f.dir, "runtime-rebaseline-publication.json")),
  );
});

test("even a committed receipt cannot bypass a corrupt native reservation", async () => {
  const f = fixture(),
    request = f.request();
  await rebaselineRuntime(f.dir, request, f.authority);
  const marker = path.join(f.dir, "runtime-rebaseline-publication.json");
  fs.writeFileSync(marker, "corrupt-publisher-outcome");
  const reads = f.reads();
  await assert.rejects(rebaselineRuntime(f.dir, request, f.authority), {
    code: "RUNTIME_PUBLICATION_PENDING",
  });
  assert.throws(() => runtimeRebaselineRoot(f.dir), {
    code: "RUNTIME_PUBLICATION_PENDING",
  });
  assert.equal(f.reads(), reads);
  assert.equal(fs.readFileSync(marker, "utf8"), "corrupt-publisher-outcome");
  await assert.rejects(
    rebaselineRuntime(
      f.dir,
      {
        ...request,
        requestId: "different-request",
        expectedHead: literalRuntimeHead(f.dir).digest,
      },
      f.authority,
    ),
    { code: "RUNTIME_PUBLICATION_PENDING" },
  );
});

test("independent runner processes publish one activation under a real exclusive writer lock", async () => {
  const f = fixture(),
    request = f.request();
  const script = `
    const fs = require("node:fs"), path = require("node:path");
    const {setTimeout: delay} = require("node:timers/promises");
    const {createHash} = require("node:crypto");
    const api = require(path.join(process.cwd(), "src/queue-runtime-rebaseline.js"));
    const {durable} = require(path.join(process.cwd(), "src/dist/node-adapters/persistence/records.js"));
    const {dir,pins,current,proof,request} = JSON.parse(process.argv[1]);
    const authority = api.createRuntimeRebaselineAuthority({
      store: dir, operatorId: "local-operator", pins,
      async withExclusiveBarrier(request,work) {
        const file = path.join(dir, "owned-writer.lock");
        let fd;
        for(let i=0;i<500;i++) {
          try {fd=fs.openSync(file,"wx");break}
          catch(e) {if(e.code!=="EEXIST") throw e; await delay(10);}
        }
        if(fd===undefined) throw Error("exclusive writer timeout");
        const inode=fs.fstatSync(fd).ino;
        function assertHeld() {if(fs.statSync(file).ino!==inode) throw Error("writer replaced")}
        try {return await work({
          initiatorOperatorId: "local-operator",
          assertWriterAndProvisionLock: assertHeld,
          async verifyCurrentBarrier() {assertHeld();await delay(40);return {binding:current,evidence:[proof]}},
          async publishActivation(p) {
            assertHeld();
            if(api.literalRuntimeHead(dir).digest!==p.expectedHead) throw Error("head changed");
            const digest = createHash("sha256").update(fs.readFileSync(p.record.path)).digest("hex");
            if(digest!==p.record.sha256) throw Error("record changed");
            durable(p.activationFile,JSON.parse(p.activationBytes));
            fs.appendFileSync(path.join(dir,"publications.log"),"published\\n");
          },
          async consumeActivation(p) {
            assertHeld();
            const binding = {requestId:request.requestId,newHead:JSON.parse(p.activationBytes).newHead,
              publicationDigest:createHash("sha256").update(JSON.stringify(p)).digest("hex"),
              initiatorOperatorId:"local-operator"};
            const file=path.join(dir,"consumed.json");
            durable(file,binding);
            return {binding,evidence:[{path:file,sha256:createHash("sha256").update(fs.readFileSync(file)).digest("hex")}]};
          }
        })} finally {fs.closeSync(fd);fs.unlinkSync(file)}
      }
    });
    api.rebaselineRuntime(dir,request,authority).then(
      value=>console.log(JSON.stringify(value)),
      e=>{console.error(e.code||e.message);process.exitCode=2}
    );
  `;
  function child() {
    return new Promise<{ code: number | null; output: string; error: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "-e",
            script,
            JSON.stringify({
              dir: f.dir,
              pins: f.pins,
              current: f.current,
              proof: f.proof,
              request,
            }),
          ],
          { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "",
          error = "";
        child.stdout.on("data", (data) => {
          output += data;
        });
        child.stderr.on("data", (data) => {
          error += data;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output, error }));
      },
    );
  }
  const [a, b] = await Promise.all([child(), child()]);
  assert.equal(a.code, 0, a.error);
  assert.equal(b.code, 0, b.error);
  assert.deepEqual(JSON.parse(a.output), JSON.parse(b.output));
  assert.equal(
    fs.readFileSync(path.join(f.dir, "publications.log"), "utf8"),
    "published\n",
  );
});

test("staging resolves known core declarations and rejects foreign workspace imports before publication", () => {
  const { stageQueueRuntime, queueRuntimeModules } = createRequire(__filename)(
    path.join(process.cwd(), "dist/scripts/devtools/stage-queue-runtime.js"),
  ) as typeof import("../scripts/devtools/stage-queue-runtime");
  for (const foreign of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rebaseline-stage-"));
    const source = path.join(root, "dist/library-build/src");
    for (const name of queueRuntimeModules) {
      const file = path.join(source, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + ".js", "compiler JavaScript bytes");
      fs.writeFileSync(file + ".d.ts", "");
    }
    fs.writeFileSync(path.join(source, "queue-broker-ports.d.ts"), "");
    fs.writeFileSync(
      path.join(source, "composition/queue-broker.d.ts"),
      foreign
        ? 'export type T = import("@fmcad/foreign").Foreign;'
        : 'export type T = import("@fmcad/core").QueueQuarantine;',
    );
    if (foreign) {
      assert.throws(() => stageQueueRuntime(root), /Unmapped workspace import/);
      assert.equal(fs.existsSync(path.join(root, "src")), false);
    } else {
      stageQueueRuntime(root);
      assert.equal(
        fs.readFileSync(
          path.join(root, "src/composition/queue-broker.d.ts"),
          "utf8",
        ),
        'export type T = import("../dist/core").QueueQuarantine;',
      );
      assert.equal(
        fs.readFileSync(
          path.join(root, "src/composition/queue-broker.js"),
          "utf8",
        ),
        "compiler JavaScript bytes",
      );
    }
  }
});
