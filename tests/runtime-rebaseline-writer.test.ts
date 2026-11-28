import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import test, { type TestContext } from "node:test";
import type { RuntimeRebaselineWriterScope } from "../src/queue-runtime-rebaseline-writer";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "dist/src/queue-broker.js"));
const { withRuntimeRebaselineWriter } = load(
  "./queue-runtime-rebaseline-writer",
) as typeof import("../src/queue-runtime-rebaseline-writer");
const { literalRuntimeHead } = load(
  "./queue-runtime-rebaseline",
) as typeof import("../src/queue-runtime-rebaseline");
const { claimBrokerLifetime } = load(
  "./dist/node-adapters/execution/broker-lifetime",
) as typeof import("../packages/node-adapters/src/execution/broker-lifetime");
const { processBirth } = load("./queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const buildHash = sha("writer-code"),
  configHash = sha("writer-config");
const writerModule = path.join(
  root,
  "dist/src/queue-runtime-rebaseline-writer.js",
);
const lifetimeModule = path.join(
  root,
  "dist/src/dist/node-adapters/execution/broker-lifetime.js",
);
const instanceModule = path.join(root, "dist/src/queue-instance.js");

function fixture(t: TestContext) {
  const home = fs.mkdtempSync("/tmp/opencode/runtime-rebaseline-writer-");
  const store = path.join(home, "fmcad", "queue");
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  const snapshot = Buffer.from(
    '{"jobs":{"old":{"state":"needs_reconciliation","rawOutcome":"UNKNOWN"}},"preserve":"byte exact"}\n',
  );
  fs.writeFileSync(path.join(store, "queue-state.json"), snapshot, {
    mode: 0o600,
  });
  fs.mkdirSync(path.join(store, "jobs", "old"), {
    recursive: true,
    mode: 0o700,
  });
  const receipt = Buffer.from(
    '{"terminal":false,"requestId":"old","outcome":"unknown"}\n',
  );
  fs.writeFileSync(
    path.join(store, "jobs", "old", "original-rpc.json"),
    receipt,
    { mode: 0o600 },
  );
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return {
    home,
    store,
    snapshot,
    receipt,
    options: { store, buildHash, configHash },
    preserved() {
      assert.deepEqual(
        fs.readFileSync(path.join(store, "queue-state.json")),
        snapshot,
      );
      assert.deepEqual(
        fs.readFileSync(path.join(store, "jobs", "old", "original-rpc.json")),
        receipt,
      );
    },
  };
}
function json(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}
function lifecycle(store: string, nonce: string) {
  return json(path.join(store, `broker-lifecycle-${nonce}.json`));
}
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

test("real Node claim precedes head/native writer entry and its same generation spans serial inner work", async (t) => {
  const f = fixture(t);
  let saved!: RuntimeRebaselineWriterScope,
    nonce = "";
  const result = await withRuntimeRebaselineWriter(
    f.options,
    async (writer) => {
      saved = writer;
      const owner = json(path.join(f.store, "broker.lock"));
      nonce = String(owner["nonce"]);
      assert.equal(owner["pid"], process.pid);
      assert.equal(owner["birth"], processBirth());
      assert.equal(owner["protocol"], 2);
      assert.equal(writer.generation, nonce);
      assert.equal(writer.head.digest, literalRuntimeHead(f.store).digest);
      const stage = lifecycle(f.store, nonce);
      assert.equal(stage["stage"], "runtime-rebaseline");
      assert.equal(stage["safeToRecover"], false);
      assert.equal(
        "grantIssuance" in stage,
        false,
        "an administrative Node claim is not an SDK grant",
      );
      for (const value of ["first", "second"]) {
        assert.equal(
          await writer.withExclusiveWriter(async (lease) => {
            assert.equal(lease.generation, nonce);
            lease.assertHeld();
            assert.equal(Object.isFrozen(lease), true);
            return value;
          }),
          value,
        );
      }
      f.preserved();
      return "administrative-only";
    },
  );
  assert.equal(result, "administrative-only");
  assert.equal(fs.existsSync(path.join(f.store, "broker.lock")), false);
  assert.equal(
    lifecycle(f.store, nonce)["stage"],
    "runtime-rebaseline-complete",
  );
  assert.throws(() => saved.assertHeld(), {
    code: "RUNTIME_REBASELINE_WRITER_CLOSED",
  });
  f.preserved();
});

test("an alive actual broker owner is never reclaimed or granted a competing writer", async (t) => {
  const f = fixture(t);
  const owner = claimBrokerLifetime({
    dir: f.store,
    socket: path.join(f.store, "queue.sock"),
    buildHash,
    configHash,
    processBirth,
    disposeClient() {},
  });
  const before = fs.readFileSync(path.join(f.store, "broker.lock"));
  let entered = false;
  try {
    await assert.rejects(
      withRuntimeRebaselineWriter(f.options, async () => {
        entered = true;
      }),
      { code: "BROKER_ALIVE" },
    );
    assert.equal(entered, false);
    assert.deepEqual(
      fs.readFileSync(path.join(f.store, "broker.lock")),
      before,
    );
    assert.equal(
      fs.existsSync(path.join(f.store, "broker-reclaimed-head.json")),
      false,
    );
    f.preserved();
  } finally {
    owner.abortBeforeInitialize();
  }
});

test("an unprovable PID birth is denied without reclaim, external queries or callback entry", async (t) => {
  const f = fixture(t);
  const lock = path.join(f.store, "broker.lock");
  fs.writeFileSync(
    lock,
    JSON.stringify({
      pid: process.pid,
      birth: "unknown",
      nonce: randomUUID(),
      protocol: 2,
    }),
    { mode: 0o600 },
  );
  const before = fs.readFileSync(lock);
  let entered = false;
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async () => {
      entered = true;
    }),
    { code: "BROKER_OWNER_UNPROVEN" },
  );
  assert.equal(entered, false);
  assert.deepEqual(fs.readFileSync(lock), before);
  assert.equal(
    fs.existsSync(path.join(f.store, "broker-reclaimed-head.json")),
    false,
  );
  f.preserved();
});

test("callback errors retain the exact administrative owner/lifecycle and do not expose secrets", async (t) => {
  const f = fixture(t);
  let nonce = "";
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async (writer) => {
      nonce = writer.generation;
      throw Object.assign(
        new Error("secret private bearer must never escape"),
        { code: "EIO" },
      );
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(String(error).includes("private bearer"), false);
      assert.equal(Reflect.get(error, "code"), "EIO");
      assert.equal("cause" in error, false);
      return true;
    },
  );
  assert.equal(json(path.join(f.store, "broker.lock"))["nonce"], nonce);
  assert.equal(lifecycle(f.store, nonce)["safeToRecover"], false);
  assert.equal(lifecycle(f.store, nonce)["stage"], "runtime-rebaseline");
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async () => {}),
    { code: "RUNTIME_REBASELINE_WRITER_RETAINED" },
  );
  f.preserved();
});

test("even a resolved callback cannot clear or replay a pending native publication", async (t) => {
  const f = fixture(t),
    marker = path.join(f.store, "runtime-rebaseline-publication.json");
  const original = Buffer.from(
    '{"opaque":"original pending publication","doNotReplay":true}\n',
  );
  let nonce = "";
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async (writer) => {
      nonce = writer.generation;
      // Publication existence is the tested boundary; no native operation occurs.
      fs.writeFileSync(marker, original, { mode: 0o600 });
      return "not a settlement";
    }),
    { code: "RUNTIME_REBASELINE_PUBLICATION_PENDING" },
  );
  assert.deepEqual(fs.readFileSync(marker), original);
  assert.equal(json(path.join(f.store, "broker.lock"))["nonce"], nonce);
  assert.equal(lifecycle(f.store, nonce)["safeToRecover"], false);
  let replayed = false;
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async () => {
      replayed = true;
    }),
    { code: "RUNTIME_REBASELINE_PUBLICATION_PENDING" },
  );
  assert.equal(replayed, false);
  assert.deepEqual(fs.readFileSync(marker), original);
  f.preserved();
});

test("owner replacement invalidates held generation and must not unlink the successor", async (t) => {
  const f = fixture(t),
    lock = path.join(f.store, "broker.lock");
  const successor = {
    pid: process.pid,
    birth: processBirth(),
    nonce: randomUUID(),
    protocol: 2,
  };
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async (writer) => {
      fs.renameSync(lock, path.join(f.store, "original-owner.json"));
      fs.writeFileSync(lock, JSON.stringify(successor), { mode: 0o600 });
      assert.throws(() => writer.assertHeld());
    }),
    { code: "RUNTIME_REBASELINE_WRITER_CHANGED" },
  );
  assert.deepEqual(json(lock), successor);
  f.preserved();
});

test("namespace replacement cannot redirect writer cleanup into a different store", async (t) => {
  const f = fixture(t),
    moved = path.join(f.home, "held-original");
  const foreign = Buffer.from("unrelated successor namespace");
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async (writer) => {
      fs.renameSync(f.store, moved);
      fs.mkdirSync(f.store, { mode: 0o700 });
      fs.writeFileSync(path.join(f.store, "broker.lock"), foreign, {
        mode: 0o600,
      });
      assert.throws(() => writer.assertHeld());
    }),
    { code: "RUNTIME_REBASELINE_WRITER_CHANGED" },
  );
  assert.deepEqual(fs.readFileSync(path.join(f.store, "broker.lock")), foreign);
  assert.equal(fs.existsSync(path.join(moved, "broker.lock")), true);
  assert.deepEqual(
    fs.readFileSync(path.join(moved, "queue-state.json")),
    f.snapshot,
  );
});

test("an escaped inner operation retains its publisher and its closed lease cannot continue", async (t) => {
  const f = fixture(t),
    held = gate();
  let task!: Promise<unknown>,
    nonce = "";
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async (writer) => {
      nonce = writer.generation;
      task = writer.withExclusiveWriter(async (lease) => {
        lease.assertHeld();
        await held.wait;
        lease.assertHeld();
      });
    }),
    { code: "RUNTIME_REBASELINE_WRITER_BUSY" },
  );
  held.open();
  await assert.rejects(task, { code: "RUNTIME_REBASELINE_WRITER_CLOSED" });
  assert.equal(json(path.join(f.store, "broker.lock"))["nonce"], nonce);
  assert.equal(lifecycle(f.store, nonce)["safeToRecover"], false);
  f.preserved();
});

test("catching an inner writer failure does not manufacture outer success", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async (writer) => {
      await assert.rejects(
        writer.withExclusiveWriter(async () => {
          throw new Error("failed inner operation");
        }),
      );
      return "caller swallowed failure";
    }),
    { code: "RUNTIME_REBASELINE_WRITER_FAILED" },
  );
  const nonce = String(json(path.join(f.store, "broker.lock"))["nonce"]);
  assert.equal(lifecycle(f.store, nonce)["safeToRecover"], false);
  f.preserved();
});

test("a caught inner failure immediately revokes outer authority and denies every subsequent callback", async (t) => {
  const f = fixture(t),
    marker = path.join(f.store, "runtime-rebaseline-publication.json");
  const publication = Buffer.from(
    '{"requestId":"first-uncertain-operation","outcome":"unknown"}\n',
  );
  let checksCompleted = false;
  let entered = false,
    nonce = "";
  let owner!: Buffer;
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async (writer) => {
      nonce = writer.generation;
      owner = fs.readFileSync(path.join(f.store, "broker.lock"));
      await assert.rejects(
        writer.withExclusiveWriter(async (lease) => {
          lease.assertHeld();
          fs.writeFileSync(marker, publication, { mode: 0o600 });
          throw new Error("uncertain first operation");
        }),
      );
      assert.throws(() => writer.assertHeld(), {
        code: "RUNTIME_REBASELINE_WRITER_FAILED",
      });
      assert.throws(
        () =>
          writer.withExclusiveWriter(async (lease) => {
            entered = true;
            lease.assertHeld();
            fs.unlinkSync(marker);
          }),
        { code: "RUNTIME_REBASELINE_WRITER_FAILED" },
      );
      checksCompleted = true;
    }),
    { code: "RUNTIME_REBASELINE_WRITER_FAILED" },
  );
  assert.equal(entered, false);
  assert.equal(checksCompleted, true);
  assert.deepEqual(fs.readFileSync(path.join(f.store, "broker.lock")), owner);
  assert.deepEqual(fs.readFileSync(marker), publication);
  assert.equal(lifecycle(f.store, nonce)["safeToRecover"], false);
  f.preserved();
});

test("captured inner leases expire before the next serial call, without changing owner generation", async (t) => {
  const f = fixture(t);
  await withRuntimeRebaselineWriter(f.options, async (writer) => {
    let expired!: { assertHeld(): void };
    await writer.withExclusiveWriter(async (lease) => {
      expired = lease;
      lease.assertHeld();
    });
    assert.throws(() => expired.assertHeld(), {
      code: "RUNTIME_REBASELINE_WRITER_CLOSED",
    });
    await writer.withExclusiveWriter(async (lease) => {
      assert.equal(lease.generation, writer.generation);
      lease.assertHeld();
      assert.throws(() => expired.assertHeld(), {
        code: "RUNTIME_REBASELINE_WRITER_CLOSED",
      });
    });
  });
  f.preserved();
});

test("callback-controlled error codes cannot disclose secrets", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async () => {
      throw Object.assign(new Error("secret"), {
        code: "SECRET_BEARER_ABCDEF",
      });
    }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(
        Reflect.get(error, "code"),
        "RUNTIME_REBASELINE_WRITER_FAILED",
      );
      assert.equal(JSON.stringify(error).includes("SECRET"), false);
      return true;
    },
  );
  f.preserved();
});

for (const successor of [
  "dead-admin",
  "alive",
  "uncertain",
  "same-owner-admin",
  "pending",
] as const) {
  test(`guarded reclaim denies ${successor} substitution at the actual primitive boundary without archiving the successor`, async (t) => {
    const f = fixture(t);
    const dead = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const {claimBrokerLifetime}=require(process.argv[1]),{processBirth}=require(process.argv[2]);
      const store=process.argv[3];
      const held=claimBrokerLifetime({dir:store,socket:store+"/queue.sock",buildHash:process.argv[4],
        configHash:process.argv[5],processBirth,disposeClient(){}});
      process.stdout.write(JSON.stringify(held.owner));
    `,
        lifetimeModule,
        instanceModule,
        f.store,
        buildHash,
        configHash,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(dead.status, 0, dead.stderr);
    const run = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
      const instance=require(process.argv[1]),original=instance.reclaim,store=process.argv[3],kind=process.argv[4];
      const lock=path.join(store,"broker.lock"),old=JSON.parse(fs.readFileSync(lock,"utf8"));
      let entered=false,successorBytes,lifecycleBytes,publicationBytes;
      instance.reclaim=(...args)=>{
        const next=kind==="same-owner-admin"||kind==="pending"?old:
          {...old,nonce:require("node:crypto").randomUUID(),
            ...(kind==="alive"?{pid:process.pid,birth:instance.processBirth()}:
              kind==="uncertain"?{pid:process.pid,birth:"unknown"}:{})};
        successorBytes=Buffer.from(JSON.stringify(next));
        fs.unlinkSync(lock);
        fs.writeFileSync(lock,successorBytes,{mode:0o600});
        if(kind==="dead-admin"||kind==="same-owner-admin"){
          lifecycleBytes=Buffer.from(JSON.stringify({owner:next,stage:"runtime-rebaseline",safeToRecover:false}));
          fs.writeFileSync(path.join(store,"broker-lifecycle-"+next.nonce+".json"),lifecycleBytes,{mode:0o600});
        }
        if(kind==="pending"){
          publicationBytes=Buffer.from('{"requestId":"original-pending","outcome":"unknown"}');
          fs.writeFileSync(path.join(store,"runtime-rebaseline-publication.json"),publicationBytes,{mode:0o600});
        }
        return original(...args);
      };
      const {withRuntimeRebaselineWriter}=require(process.argv[2]);
      withRuntimeRebaselineWriter({store,buildHash:process.argv[5],configHash:process.argv[6]},
        async()=>{entered=true})
        .then(()=>{throw Error("unexpected successful reclaim")},error=>{
          assert.equal(entered,false);
          assert.deepEqual(fs.readFileSync(lock),successorBytes);
          assert.equal(fs.readdirSync(store).some(name=>name.startsWith("reclaimed-")),false);
          assert.equal(fs.existsSync(path.join(store,"broker-reclaimed-head.json")),false);
          assert.equal(fs.existsSync(path.join(store,"recovery.lock")),false);
          if(publicationBytes)assert.deepEqual(fs.readFileSync(path.join(store,"runtime-rebaseline-publication.json")),publicationBytes);
          if(lifecycleBytes){
            const next=JSON.parse(successorBytes);
            assert.deepEqual(fs.readFileSync(path.join(store,"broker-lifecycle-"+next.nonce+".json")),lifecycleBytes);
          }
          process.stdout.write(error.code);
        }).catch(error=>{process.stderr.write(String(error.stack));process.exitCode=1});
    `,
        instanceModule,
        writerModule,
        f.store,
        successor,
        buildHash,
        configHash,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.equal(
      run.stdout,
      successor === "same-owner-admin"
        ? "RUNTIME_REBASELINE_WRITER_RETAINED"
        : successor === "pending"
          ? "RUNTIME_REBASELINE_PUBLICATION_PENDING"
          : successor === "alive"
            ? "BROKER_ALIVE"
            : "RUNTIME_REBASELINE_WRITER_CHANGED",
    );
    f.preserved();
  });
}

for (const swap of [
  "owner",
  "identical-bytes",
  "namespace",
  "recovery",
  "recovery-before-pin",
] as const) {
  test(`guarded reclaim rechecks ${swap} at claim or publication boundaries`, async (t) => {
    const f = fixture(t);
    const dead = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const {claimBrokerLifetime}=require(process.argv[1]),{processBirth}=require(process.argv[2]);
      const store=process.argv[3];
      const held=claimBrokerLifetime({dir:store,socket:store+"/queue.sock",buildHash:process.argv[4],
        configHash:process.argv[5],processBirth,disposeClient(){}});
      process.stdout.write(JSON.stringify(held.owner));
    `,
        lifetimeModule,
        instanceModule,
        f.store,
        buildHash,
        configHash,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(dead.status, 0, dead.stderr);
    const recordsModule = path.join(
      root,
      "dist/src/dist/node-adapters/persistence/records.js",
    );
    const run = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict");
      const records=require(process.argv[1]),original=records.durable,store=process.argv[3],kind=process.argv[4];
      const old=JSON.parse(fs.readFileSync(path.join(store,"broker.lock"),"utf8"));
      let changed=false,entered=false,nextBytes,held=store;
      records.durable=(file,...args)=>{
        const result=original(file,...args);
        if(!changed&&kind==="recovery-before-pin"&&path.basename(file)==="recovery.lock"){
          changed=true;
          nextBytes=fs.readFileSync(path.join(store,"broker.lock"));
          fs.renameSync(path.join(store,"recovery.lock"),path.join(store,"original-recovery.json"));
          fs.writeFileSync(path.join(store,"recovery.lock"),"foreign-recovery-before-pin",{mode:0o600});
          return result;
        }
        if(!changed&&path.basename(file).startsWith("reclaimed-")){
          changed=true;
          if(kind==="recovery"){
            nextBytes=fs.readFileSync(path.join(store,"broker.lock"));
            fs.renameSync(path.join(store,"recovery.lock"),path.join(store,"original-recovery.json"));
            fs.writeFileSync(path.join(store,"recovery.lock"),"foreign-recovery-owner",{mode:0o600});
            return result;
          }
          const next=kind==="owner"?{...old,nonce:require("node:crypto").randomUUID()}:old;
          nextBytes=Buffer.from(JSON.stringify(next));
          if(kind==="namespace"){
            held=store+"-original";
            fs.renameSync(store,held);
            fs.mkdirSync(store,{mode:0o700});
            fs.writeFileSync(path.join(store,"recovery.lock"),"unrelated-recovery",{mode:0o600});
          }else fs.renameSync(path.join(store,"broker.lock"),path.join(store,"original-owner.json"));
          fs.writeFileSync(path.join(store,"broker.lock"),nextBytes,{mode:0o600});
        }
        return result;
      };
      const {withRuntimeRebaselineWriter}=require(process.argv[2]);
      withRuntimeRebaselineWriter({store,buildHash:process.argv[5],configHash:process.argv[6]},
        async()=>{entered=true}).then(()=>{throw Error("unexpected success")},error=>{
          assert.equal(changed,true);assert.equal(entered,false);
          assert.deepEqual(fs.readFileSync(path.join(store,"broker.lock")),nextBytes);
          assert.equal(fs.existsSync(path.join(held,"broker-reclaimed-head.json")),false);
          for(const file of fs.readdirSync(held).filter(name=>name.startsWith("reclaimed-")))
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(held,file),"utf8")),old);
          if(kind==="recovery"||kind==="recovery-before-pin")
            assert.equal(fs.readFileSync(path.join(held,"recovery.lock"),"utf8"),
              kind==="recovery"?"foreign-recovery-owner":"foreign-recovery-before-pin");
          else assert.equal(fs.existsSync(path.join(held,"recovery.lock")),false);
          if(kind==="namespace")
            assert.equal(fs.readFileSync(path.join(store,"recovery.lock"),"utf8"),"unrelated-recovery");
          process.stdout.write(error.code);
        }).catch(error=>{process.stderr.write(String(error.stack));process.exitCode=1});
    `,
        recordsModule,
        writerModule,
        f.store,
        swap,
        buildHash,
        configHash,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.equal(
      run.stdout,
      swap === "namespace"
        ? "RUNTIME_REBASELINE_WRITER_CHANGED"
        : "LOCK_CHANGED",
    );
    if (swap !== "namespace") f.preserved();
    else
      assert.deepEqual(
        fs.readFileSync(path.join(f.store + "-original", "queue-state.json")),
        f.snapshot,
      );
  });
}

for (const preserve of [false, true]) {
  for (const verdict of ["pending", "rejected", "value"] as const) {
    test(`guarded reclaim refuses a ${verdict} guard result before archive (preserve SDK head: ${preserve})`, async (t) => {
      const f = fixture(t);
      const dead = spawnSync(
        process.execPath,
        [
          "-e",
          `
      const {claimBrokerLifetime}=require(process.argv[1]),{processBirth}=require(process.argv[2]);
      const store=process.argv[3];
      claimBrokerLifetime({dir:store,socket:store+"/queue.sock",buildHash:process.argv[4],
        configHash:process.argv[5],processBirth,disposeClient(){}});
    `,
          lifetimeModule,
          instanceModule,
          f.store,
          buildHash,
          configHash,
        ],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.equal(dead.status, 0, dead.stderr);
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          `
      const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
      const {reclaim}=require(process.argv[1]),store=process.argv[2],kind=process.argv[3];
      const bytes=fs.readFileSync(path.join(store,"broker.lock"));
      let unhandled=false;
      process.on("unhandledRejection",()=>{unhandled=true});
      let denied=false;
      try {
         reclaim(store,undefined,()=>kind==="pending"?new Promise(()=>{}):
           kind==="rejected"?Promise.reject(new Error("private guard rejection")):42,
           process.argv[4]==="true"?{preserveSdkOwnerHead:true}:{});
      } catch(error) { assert.equal(error.code,"INVALID_RECLAIM_GUARD");denied=true; }
      setImmediate(()=>{
        assert.equal(denied,true);
        assert.equal(unhandled,false);
        assert.deepEqual(fs.readFileSync(path.join(store,"broker.lock")),bytes);
        assert.equal(fs.readdirSync(store).some(name=>name.startsWith("reclaimed-")),false);
        assert.equal(fs.existsSync(path.join(store,"broker-reclaimed-head.json")),false);
        assert.equal(fs.existsSync(path.join(store,"recovery.lock")),false);
        process.stdout.write("DENIED_SYNCHRONOUSLY");
      });
    `,
          instanceModule,
          f.store,
          verdict,
          String(preserve),
        ],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(result.stdout, "DENIED_SYNCHRONOUSLY");
      f.preserved();
    });
  }
}

for (const mode of ["preserve", "default", "unguarded", "recovery"] as const) {
  test(`dead administrative owner reclaim ${mode} preserves original evidence`, (t) => {
    const f = fixture(t);
    const priorHead = Buffer.from(
      '{"last":"actual SDK owner, not this administrative writer"}\n',
    );
    fs.writeFileSync(
      path.join(f.store, "broker-reclaimed-head.json"),
      priorHead,
      { mode: 0o600 },
    );
    const dead = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const {claimBrokerLifetime}=require(process.argv[1]),{processBirth}=require(process.argv[2]);
      claimBrokerLifetime({dir:process.argv[3],socket:process.argv[3]+"/queue.sock",
        buildHash:process.argv[4],configHash:process.argv[5],processBirth,disposeClient(){}});
    `,
        lifetimeModule,
        instanceModule,
        f.store,
        buildHash,
        configHash,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(dead.status, 0, dead.stderr);
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
      const fs=require("node:fs"),assert=require("node:assert/strict"),path=require("node:path");
      const {reclaim}=require(process.argv[1]),store=process.argv[2],mode=process.argv[3];
      const lock=fs.readFileSync(path.join(store,"broker.lock"));
      const owner=JSON.parse(lock),head=fs.readFileSync(path.join(store,"broker-reclaimed-head.json"));
      const guard=current=>assert.deepEqual(current,owner);
      if(mode==="unguarded"||mode==="recovery"){
        let recovered=false;
        assert.throws(()=>reclaim(store,mode==="recovery"?()=>{recovered=true}:undefined,
          mode==="recovery"?guard:undefined,{preserveSdkOwnerHead:true}),
          {code:"INVALID_RECLAIM_GUARD"});
        assert.equal(recovered,false);
        assert.deepEqual(fs.readFileSync(path.join(store,"broker.lock")),lock);
        assert.equal(fs.readdirSync(store).some(n=>n.startsWith("reclaimed-")),false);
      }else{
        const value=reclaim(store,undefined,guard,mode==="preserve"?{preserveSdkOwnerHead:true}:{});
        assert.equal(value.reclaimed,true);
        assert.equal(fs.existsSync(path.join(store,"broker.lock")),false);
        const archived=fs.readdirSync(store).filter(n=>n.startsWith("reclaimed-"));
        assert.equal(archived.length,1);
        assert.deepEqual(fs.readFileSync(path.join(store,archived[0])),lock);
      }
      const next=fs.readFileSync(path.join(store,"broker-reclaimed-head.json"));
      if(mode==="default")assert.notDeepEqual(next,head);else assert.deepEqual(next,head);
      assert.equal(fs.existsSync(path.join(store,"recovery.lock")),false);
      process.stdout.write("PASS");
    `,
        instanceModule,
        f.store,
        mode,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(result.stdout, "PASS");
    f.preserved();
  });
}

function publisher(t: TestContext, store: string, pending: boolean) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const fs=require("node:fs"),path=require("node:path");
    const {withRuntimeRebaselineWriter}=require(process.argv[1]);
    const store=process.argv[2],pending=process.argv[3]==="pending";
    withRuntimeRebaselineWriter({store,buildHash:process.argv[4],configHash:process.argv[5]},async writer=>{
      await writer.withExclusiveWriter(async lease=>{
        lease.assertHeld();
        if(pending)fs.writeFileSync(path.join(store,"runtime-rebaseline-publication.json"),
          JSON.stringify({requestId:"original-publication",nativeOutcome:"unknown"}),{mode:0o600});
        process.stdout.write("WRITER_READY "+JSON.stringify({nonce:lease.generation,pid:process.pid})+"\\n");
        await new Promise(resolve=>process.stdin.once("data",resolve));
        lease.assertHeld();
      });
    }).then(()=>process.exit(0),error=>{process.stderr.write(error.code+"\\n");process.exit(1)});
  `,
      writerModule,
      store,
      pending ? "pending" : "no-publication",
      buildHash,
      configHash,
    ],
    {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "",
    started = false;
  let markReady!: (value: { nonce: string; pid: number }) => void;
  let failedReady!: (error: Error) => void;
  const ready = new Promise<{ nonce: string; pid: number }>(
    (resolve, reject) => {
      markReady = resolve;
      failedReady = reject;
    },
  );
  child.stdout.on("data", (data: Buffer) => {
    stdout += data.toString();
    const match = /WRITER_READY (.+)\n/.exec(stdout);
    if (match && !started) {
      started = true;
      markReady(JSON.parse(match[1]!) as { nonce: string; pid: number });
    }
  });
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", (error) => {
      failedReady(error);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (!started)
        failedReady(
          new Error("Writer did not enter its held scope: " + stderr + stdout),
        );
      resolve({ code, signal });
    });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await done;
  });
  return { child, ready, done, stderr: () => stderr };
}

test("supported exact-dead Node reclaim preserves opaque legacy snapshots and computes head after claim", async (t) => {
  const f = fixture(t);
  // Not valid Domain JSON: administrative metadata must not restore/reconcile it.
  const opaque = Buffer.from(
    "legacy snapshot bytes remain UNKNOWN and unparsed\n",
  );
  fs.writeFileSync(path.join(f.store, "queue-state.json"), opaque, {
    mode: 0o600,
  });
  const previous = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const {claimBrokerLifetime}=require(process.argv[1]);
    const {processBirth}=require(process.argv[2]);
    const held=claimBrokerLifetime({dir:process.argv[3],socket:process.argv[3]+"/queue.sock",
      buildHash:process.argv[4],configHash:process.argv[5],processBirth,disposeClient(){}});
    process.stdout.write(JSON.stringify(held.owner));
  `,
      lifetimeModule,
      instanceModule,
      f.store,
      buildHash,
      configHash,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(previous.status, 0, previous.stderr);
  const old: unknown = JSON.parse(previous.stdout);
  await withRuntimeRebaselineWriter(f.options, async (writer) => {
    const current = json(path.join(f.store, "broker.lock"));
    assert.equal(current["pid"], process.pid);
    assert.equal(current["nonce"], writer.generation);
    const reclaimed = json(path.join(f.store, "broker-reclaimed-head.json"));
    const reference = reclaimed["ownerReference"];
    assert.ok(reference && typeof reference === "object");
    const archivedPath = Reflect.get(reference, "path");
    assert.equal(typeof archivedPath, "string");
    assert.equal(
      path.dirname(String(archivedPath)),
      f.store,
      "reclaim references remain canonical, never ephemeral /proc FD paths",
    );
    assert.deepEqual(json(String(archivedPath)), old);
    assert.equal(
      sha(fs.readFileSync(String(archivedPath))),
      Reflect.get(reference, "sha256"),
    );
    assert.equal(writer.head.digest, literalRuntimeHead(f.store).digest);
    assert.deepEqual(
      fs.readFileSync(path.join(f.store, "queue-state.json")),
      opaque,
    );
  });
  assert.deepEqual(
    fs.readFileSync(path.join(f.store, "queue-state.json")),
    opaque,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(f.store, "jobs", "old", "original-rpc.json")),
    f.receipt,
  );
});

test(
  "independent processes race on the actual broker.lock, not a test writer token",
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t),
      first = publisher(t, f.store, false);
    const held = await first.ready;
    const contender = spawnSync(
      process.execPath,
      [
        "-e",
        `
    const {withRuntimeRebaselineWriter}=require(process.argv[1]);
    withRuntimeRebaselineWriter({store:process.argv[2],buildHash:process.argv[3],configHash:process.argv[4]},
      async()=>{throw Error("unexpected competing entry")})
      .then(()=>process.exit(2),error=>{process.stdout.write(error.code);process.exit(error.code==="RUNTIME_REBASELINE_WRITER_RETAINED"?0:1)});
  `,
        writerModule,
        f.store,
        buildHash,
        configHash,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(contender.status, 0, contender.stderr + contender.stdout);
    assert.equal(contender.stdout, "RUNTIME_REBASELINE_WRITER_RETAINED");
    assert.equal(json(path.join(f.store, "broker.lock"))["nonce"], held.nonce);
    first.child.stdin.end("release\n");
    assert.equal((await first.done).code, 0, first.stderr());
    assert.equal(fs.existsSync(path.join(f.store, "broker.lock")), false);
    f.preserved();
  },
);

for (const pending of [false, true]) {
  test(
    `killed administrative publisher ${pending ? "with" : "without"} a native marker cannot be replayed or reclaimed by ordinary autostart`,
    { timeout: 15000 },
    async (t) => {
      const f = fixture(t),
        owner = publisher(t, f.store, pending);
      const held = await owner.ready;
      const before = fs.readFileSync(path.join(f.store, "broker.lock"));
      const publication = pending
        ? fs.readFileSync(
            path.join(f.store, "runtime-rebaseline-publication.json"),
          )
        : null;
      assert.equal(
        lifecycle(f.store, held.nonce)["stage"],
        "runtime-rebaseline",
      );
      assert.equal(lifecycle(f.store, held.nonce)["safeToRecover"], false);
      owner.child.kill("SIGKILL");
      assert.equal((await owner.done).signal, "SIGKILL");
      let replayed = false;
      await assert.rejects(
        withRuntimeRebaselineWriter(f.options, async () => {
          replayed = true;
        }),
        {
          code: pending
            ? "RUNTIME_REBASELINE_PUBLICATION_PENDING"
            : "RUNTIME_REBASELINE_WRITER_RETAINED",
        },
      );
      assert.equal(replayed, false);
      const autostart = path.join(
        root,
        "dist/src/dist/entrypoints/queue-autostart.js",
      );
      const observed = spawnSync(
        process.execPath,
        [
          "-e",
          `
        let starts=0;
        require("node:child_process").spawn=()=>{starts++;throw Error("UNEXPECTED_AUTOSTART");};
        const {ensureBroker}=require(process.argv[1]);
        ensureBroker({routing:"queue",queue:{autoStart:true,autoRecover:true,startupTimeoutMs:150}},
          {clientId:"isolated-check",clientToken:"private-fixture-token"})
          .then(()=>process.exit(2),error=>{
            process.stdout.write(JSON.stringify({code:error.code,starts}));
            process.exit(error.code==="BROKER_START_TIMEOUT"&&starts===0?0:1);
          });
      `,
          autostart,
        ],
        {
          cwd: root,
          env: { ...process.env, XDG_STATE_HOME: f.home },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(observed.status, 0, observed.stderr + observed.stdout);
      assert.deepEqual(JSON.parse(observed.stdout), {
        code: "BROKER_START_TIMEOUT",
        starts: 0,
      });
      assert.deepEqual(
        fs.readFileSync(path.join(f.store, "broker.lock")),
        before,
      );
      assert.equal(
        fs.existsSync(path.join(f.store, "broker-reclaimed-head.json")),
        false,
      );
      if (publication)
        assert.deepEqual(
          fs.readFileSync(
            path.join(f.store, "runtime-rebaseline-publication.json"),
          ),
          publication,
        );
      f.preserved();
    },
  );
}

test("symlinked or non-private store namespaces are denied before owner claim", async (t) => {
  const f = fixture(t),
    alias = path.join(f.home, "alias");
  fs.symlinkSync(f.store, alias);
  await assert.rejects(
    withRuntimeRebaselineWriter({ ...f.options, store: alias }, async () => {}),
    { code: "UNSAFE_DIRECTORY" },
  );
  fs.chmodSync(f.store, 0o755);
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async () => {}),
    { code: "UNSAFE_DIRECTORY" },
  );
  assert.equal(fs.existsSync(path.join(f.store, "broker.lock")), false);
  f.preserved();
});

test("private owner FD detects a rewritten identical marker, not only a changed PID/nonce", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async (writer) => {
      const file = path.join(f.store, "broker.lock"),
        bytes = fs.readFileSync(file);
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      const future = new Date(Date.now() + 10000);
      fs.utimesSync(file, future, future);
      writer.assertHeld();
    }),
    { code: "RUNTIME_REBASELINE_WRITER_CHANGED" },
  );
  assert.equal(fs.existsSync(path.join(f.store, "broker.lock")), true);
  f.preserved();
});

test("private metadata refuses ambiguous owners, extra caller verdicts and noncanonical birth strings", async (t) => {
  const f = fixture(t),
    nonce = randomUUID(),
    lock = path.join(f.store, "broker.lock");
  const cases = [
    JSON.stringify({
      pid: process.pid,
      birth: "-".repeat(36) + ":1",
      nonce,
      protocol: 2,
    }),
    JSON.stringify({
      pid: process.pid,
      birth: processBirth(),
      nonce,
      protocol: 2,
      callerConfirmedDead: true,
    }),
    `{"pid":${process.pid},"pid":99999999,"birth":${JSON.stringify(processBirth())},"nonce":${JSON.stringify(nonce)},"protocol":2}`,
  ];
  for (const bytes of cases) {
    fs.writeFileSync(lock, bytes, { mode: 0o600 });
    let entered = false;
    await assert.rejects(
      withRuntimeRebaselineWriter(f.options, async () => {
        entered = true;
      }),
    );
    assert.equal(entered, false);
    assert.equal(fs.readFileSync(lock, "utf8"), bytes);
    assert.equal(
      fs.existsSync(path.join(f.store, "broker-reclaimed-head.json")),
      false,
    );
  }
  f.preserved();
});

test("an existing recovery owner and a non-private broker marker are not bypassed", async (t) => {
  const f = fixture(t),
    recovery = path.join(f.store, "recovery.lock");
  fs.writeFileSync(recovery, "another supported recovery owns this path\n", {
    mode: 0o600,
  });
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async () => {}),
    { code: "RUNTIME_REBASELINE_WRITER_BUSY" },
  );
  assert.equal(fs.existsSync(path.join(f.store, "broker.lock")), false);
  assert.equal(
    fs.readFileSync(recovery, "utf8"),
    "another supported recovery owns this path\n",
  );
  fs.unlinkSync(recovery);
  const lock = path.join(f.store, "broker.lock");
  fs.writeFileSync(
    lock,
    JSON.stringify({
      pid: process.pid,
      birth: processBirth(),
      nonce: randomUUID(),
      protocol: 2,
    }),
    { mode: 0o644 },
  );
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async () => {}),
    { code: "UNSAFE_ARTIFACT" },
  );
  f.preserved();
});

test("inner writer overlap is denied without reacquiring or changing the held owner generation", async (t) => {
  const f = fixture(t),
    waiting = gate();
  await withRuntimeRebaselineWriter(f.options, async (writer) => {
    const first = writer.withExclusiveWriter(async (lease) => {
      await waiting.wait;
      lease.assertHeld();
      return lease.generation;
    });
    assert.throws(() => writer.withExclusiveWriter(async () => "unexpected"), {
      code: "RUNTIME_REBASELINE_WRITER_BUSY",
    });
    waiting.open();
    assert.equal(await first, writer.generation);
    assert.equal(
      json(path.join(f.store, "broker.lock"))["nonce"],
      writer.generation,
    );
    assert.equal(
      await writer.withExclusiveWriter(async (lease) => lease.generation),
      writer.generation,
    );
  });
  f.preserved();
});

test("fresh scope does not infer permission to resume a dead ADMIN from a completed metadata flag", async (t) => {
  const f = fixture(t);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const fs=require("node:fs"),path=require("node:path");
    const {claimBrokerLifetime}=require(process.argv[1]);
    const {processBirth}=require(process.argv[2]);
    const store=process.argv[3];
    const held=claimBrokerLifetime({dir:store,socket:store+"/queue.sock",
      buildHash:process.argv[4],configHash:process.argv[5],processBirth,disposeClient(){}});
    fs.writeFileSync(path.join(store,"broker-lifecycle-"+held.owner.nonce+".json"),
      JSON.stringify({owner:held.owner,stage:"runtime-rebaseline-complete",safeToRecover:true}),{mode:0o600});
  `,
      lifetimeModule,
      instanceModule,
      f.store,
      buildHash,
      configHash,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(child.status, 0, child.stderr);
  const before = fs.readFileSync(path.join(f.store, "broker.lock"));
  await assert.rejects(
    withRuntimeRebaselineWriter(f.options, async () => {}),
    { code: "RUNTIME_REBASELINE_WRITER_RETAINED" },
  );
  assert.deepEqual(fs.readFileSync(path.join(f.store, "broker.lock")), before);
  assert.equal(
    fs.existsSync(path.join(f.store, "broker-reclaimed-head.json")),
    false,
  );
  f.preserved();
});
