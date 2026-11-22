import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  createNativeRuntimeRebaselineAuthorityPorts,
  type NativeRuntimeRebaselineOptions,
  type NativeRuntimeActivationCompletion,
  type NativeRuntimeActivationPublication,
} from "../packages/node-adapters/src/execution/runtime-rebaseline-native";
import { runtimeRebaselineManifestNames } from "../packages/node-adapters/src/persistence/runtime-rebaseline-scope";
import type { PhysicalGenerationDescriptor } from "../packages/node-adapters/src/execution/physical-generation";

const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** Separate executable, persistent fake issuer store, actual Linux files.
 * No Fusion, production DB, grant or SDK call is used by this fixture. */
function fixture(epoch = false) {
  const directory = fs.mkdtempSync("/tmp/opencode/native-barrier-test-");
  const write = (name: string, value: unknown) => {
    const bytes = Buffer.from(
      typeof value === "string" ? value : JSON.stringify(value),
    );
    const file = path.join(directory, name);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return { path: file, sha256: sha(bytes) };
  };
  const store = path.join(directory, "store");
  fs.mkdirSync(store, { mode: 0o700 });
  fs.writeFileSync(path.join(store, "queue-state.json"), "{}", { mode: 0o600 });
  if (epoch) {
    const epochRoot = path.join(store, "admission-epochs", "current");
    fs.mkdirSync(epochRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(store, "isolated-admission-epoch.json"),
      JSON.stringify({ epochId: "current", root: epochRoot }),
      { mode: 0o600 },
    );
    for (const name of ["instance.json", "queue-state.json"])
      fs.writeFileSync(path.join(epochRoot, name), "{}", { mode: 0o600 });
  }
  fs.mkdirSync(path.join(directory, "lib"));
  const files: Record<string, string> = {};
  for (const name of [
    "physical_authority.py",
    "request_admission.py",
    "rebaseline_fence.py",
  ]) {
    const raw = "# owned offline source\n";
    fs.writeFileSync(path.join(directory, "lib", name), raw);
    files[`lib/${name}`] = sha(raw);
  }
  const executable = path.join(directory, "python.exe");
  const state = path.join(directory, "fake-native-state.json");
  const fault = path.join(directory, "fault.json");
  const trace = path.join(directory, "native-actions.txt");
  const scriptFile = path.join(directory, "actual-transmitted-script.py");
  fs.writeFileSync(
    executable,
    `#!${process.execPath}
const fs=require('node:fs'),crypto=require('node:crypto');
let raw='';process.stdin.on('data',b=>raw+=b);
process.stdin.on('end',()=>{
const e=JSON.parse(raw),q=JSON.parse(e.requestJson);
fs.appendFileSync(${JSON.stringify(trace)},e.action+'\\n');
const fault=fs.existsSync(${JSON.stringify(fault)})?JSON.parse(fs.readFileSync(${JSON.stringify(fault)})):{};
if(fault.action===e.action&&fault.fail)process.exit(79);
fs.writeFileSync(${JSON.stringify(scriptFile)},process.argv.at(-1));
const file=${JSON.stringify(state)};
let current=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
if(e.action==='begin'){
 if(!current) current={kind:'fmcad-provision-fence',version:1,state:'pending',binding:{
 requestId:q.requestId,fenceNonce:'fixture-nonce',handoffId:q.handoffId,
 generation:e.descriptor.generation,physicalRuntime:e.descriptor.physicalRuntime,
 endpointURL:'http://127.0.0.1:8765',store:q.store,oldHead:q.expectedHead,
 intentReferences:q.intentReferences,initiatorOperatorId:'operator-one',writerGeneration:q.writerGeneration}};
 fs.writeFileSync(file,JSON.stringify(current),{mode:0o600});
}
if(!current){process.stdout.write(JSON.stringify({kind:'fmcad-provision-fence',version:1,state:'absent',requestId:q.requestId}));return;}
if(e.action==='consume'){
 const publication=JSON.parse(q.publicationJson),activation=JSON.parse(publication.activationBytes);
 const digest=crypto.createHash('sha256').update(q.publicationJson).digest('hex');
 function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v;}
 const mac=crypto.createHmac('sha256',Buffer.alloc(32,7)).update('fmcad-posix-publication-v1\\0').update(JSON.stringify(sort({binding:current.binding,publicationDigest:digest}))).digest('hex');
 if(q.attestation.mac!==mac)process.exit(80);
 const receipt={kind:'fmcad-rebaseline-consumed',version:1,fence:current.binding,activation:{
 requestId:current.binding.requestId,fenceNonce:current.binding.fenceNonce,newHead:activation.newHead,
 publicationDigest:digest,record:publication.record,initiatorOperatorId:current.binding.initiatorOperatorId},consumedBy:'operator-one'};
 const receiptJson=JSON.stringify(receipt);
 current={...current,state:'consumed',publicationJson:q.publicationJson,receiptJson,
 receiptDigest:crypto.createHash('sha256').update(receiptJson).digest('hex'),
 receiptMac:crypto.createHmac('sha256',Buffer.alloc(32,7)).update('fmcad-native-consume-v1\\0').update(receiptJson).digest('hex')};
 fs.writeFileSync(file,JSON.stringify(current),{mode:0o600});
}
if(fault.corruptReceipt&&current.state==='consumed')current.receiptMac='0'.repeat(64);
process.stdout.write(JSON.stringify(current));
});`,
    { mode: 0o700 },
  );
  const committed = {
    state: "committed",
    handoffId: "handoff",
    nextGeneration: { instance: "instance", epoch: "epoch" },
  };
  const retired = write("retired.json", {
    exited: true,
    oldPidPresent: false,
    forceUsed: false,
    oldPid: 11,
    oldBirth: "old-birth",
  });
  const options: NativeRuntimeRebaselineOptions = {
    store,
    operatorId: "operator-one",
    runtimeVersion: "test",
    pins: {
      handoffId: "handoff",
      admissionStore: "C:\\private\\admission.sqlite3",
      generation: committed.nextGeneration,
      process: { pid: 22, birth: "new-birth" },
      source: "source",
      build: "build",
      endpoint: "http://127.0.0.1:8765",
    },
    evidenceDirectory: directory,
    originalEvidence: {
      retiredProcess: retired,
      coldProcess: write("cold.json", {
        pid: 22,
        birth: "new-birth",
        exe: "C:\\Fusion.exe",
      }),
      completedHandoff: write("completed.json", {
        ...committed,
        state: "completed",
      }),
      committedHandoff: write("committed.json", committed),
      preservedRows: write("rows.json", {
        databasePath: "C:\\private\\admission.sqlite3",
        sameDatabase: true,
        allOldAdmissionRowsPreserved: true,
        allOldHistoryRowsPreserved: true,
        exactlyOneCommittedHandoffRow: true,
        handoffReceipt: committed,
        grantIssued: false,
        sdkProgramSubmitted: false,
      }),
      sourceArchive: write("archive.bin", "original archive"),
    },
    native: {
      nativePython: "C:\\Python\\python.exe",
      mappedNativePython: executable,
      nativePythonSha256: sha(fs.readFileSync(executable)),
      installedForkDirectory: "C:\\fork",
      mappedInstalledForkDirectory: directory,
      installedPackageFiles: files,
      provisionPath: "C:\\private\\provision.json",
      localAppData: "C:\\private",
      nativePrivateDirectory: "C:\\private",
      mappedPrivateDirectory: directory,
      linuxGrantDirectory: directory,
    },
    publicationAuthority: {
      keyId: "fixture-key",
      keyReference: (() => {
        const bytes = Buffer.alloc(32, 7),
          file = path.join(directory, "key");
        fs.writeFileSync(file, bytes, { mode: 0o600 });
        return { path: file, sha256: sha(bytes) };
      })(),
      nativeOperatorFile: "C:\\private\\operator.json",
    },
    writer: {
      async withExclusiveWriter(work) {
        const lock = path.join(directory, "writer.lock");
        const fd = fs.openSync(lock, "wx", 0o600);
        try {
          return await work({
            generation: "writer-one",
            assertHeld() {
              assert.equal(fs.fstatSync(fd).ino, fs.statSync(lock).ino);
            },
          });
        } finally {
          fs.closeSync(fd);
          fs.unlinkSync(lock);
        }
      },
    },
  };
  const names = runtimeRebaselineManifestNames(
    store,
    epoch
      ? fs.readFileSync(path.join(store, "isolated-admission-epoch.json"))
      : null,
  );
  const manifest = Object.fromEntries(
    names.map((name) => [
      name,
      fs.existsSync(path.join(store, name))
        ? sha(fs.readFileSync(path.join(store, name)))
        : null,
    ]),
  );
  const info = fs.statSync(store);
  const request = {
    requestId: "request",
    handoffId: "handoff",
    expectedHead: sha(
      JSON.stringify({ store, device: info.dev, inode: info.ino, manifest }),
    ),
  };
  return {
    directory,
    state,
    fault,
    trace,
    scriptFile,
    options,
    request,
    manifest,
    cleanup() {
      fs.rmSync(directory, { recursive: true });
    },
  };
}

test("native fence barrier binds immutable source refs and compiles exact transmitted script", async () => {
  const f = fixture();
  try {
    const ports = createNativeRuntimeRebaselineAuthorityPorts(f.options);
    await ports.withExclusiveBarrier(
      f.request,
      "publish-or-resume",
      async (lease) => {
        assert.equal(lease.initiatorOperatorId, "operator-one");
        const first = await lease.verifyCurrentBarrier();
        assert.equal(first.binding.writerGeneration, "writer-one");
        assert.deepEqual(await lease.verifyCurrentBarrier(), first);
        assert.ok(
          fs.existsSync(
            path.join(f.options.store, "runtime-rebaseline-publication.json"),
          ),
        );
        const compiled = spawnSync("python3", [
          "-I",
          "-S",
          "-B",
          "-c",
          "import sys;compile(open(sys.argv[1],'rb').read(),sys.argv[1],'exec')",
          f.scriptFile,
        ]);
        assert.equal(compiled.status, 0, compiled.stderr.toString());
      },
    );
    assert.equal(JSON.parse(fs.readFileSync(f.state, "utf8")).state, "pending");
    assert.ok(
      fs.existsSync(
        path.join(f.options.store, "runtime-rebaseline-publication.json"),
      ),
    );
  } finally {
    f.cleanup();
  }
});

test("changed original evidence refuses before any native process/fence", () => {
  const f = fixture();
  try {
    fs.appendFileSync(f.options.originalEvidence.retiredProcess.path, " ");
    assert.throws(() => createNativeRuntimeRebaselineAuthorityPorts(f.options));
    assert.equal(fs.existsSync(f.state), false);
  } finally {
    f.cleanup();
  }
});

test("archived cold PID and birth must match the pinned current pair before BEGIN", () => {
  for (const process of [
    { pid: 23, birth: "new-birth" },
    { pid: 22, birth: "other-birth" },
  ]) {
    const f = fixture();
    try {
      f.options.pins.process = process;
      assert.throws(() =>
        createNativeRuntimeRebaselineAuthorityPorts(f.options),
      );
      assert.equal(fs.existsSync(f.state), false);
    } finally {
      f.cleanup();
    }
  }
});

test("FIFO key/evidence/marker refuses on the actual nonblocking fd without holding the writer indefinitely", () => {
  for (const kind of ["key", "evidence", "marker"]) {
    const f = fixture();
    try {
      const moduleFile =
        require.resolve("../packages/node-adapters/src/execution/runtime-rebaseline-native");
      const worker = `
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {createNativeRuntimeRebaselineAuthorityPorts}=require(${JSON.stringify(moduleFile)});
const {options,request,kind}=JSON.parse(fs.readFileSync(0,'utf8'));
options.writer={async withExclusiveWriter(work){
 const file=path.join(options.evidenceDirectory,'writer.lock'),fd=fs.openSync(file,'wx',0o600);
 try{return await work({generation:'writer-fifo',assertHeld(){fs.fstatSync(fd);}});}
 finally{fs.closeSync(fd);fs.unlinkSync(file);}
}};
const target=kind==='key'?options.publicationAuthority.keyReference.path:
 kind==='evidence'?options.originalEvidence.sourceArchive.path:
 path.join(options.store,'runtime-rebaseline-publication.json');
(async()=>{
 let ports;
 if(kind!=='key')ports=createNativeRuntimeRebaselineAuthorityPorts(options);
 if(fs.existsSync(target))fs.unlinkSync(target);
 const fifo=spawnSync('mkfifo',['-m','600',target]);if(fifo.status!==0)process.exit(3);
 try{
  if(!ports)ports=createNativeRuntimeRebaselineAuthorityPorts(options);
  await ports.withExclusiveBarrier(request,'publish-or-resume',async lease=>lease.verifyCurrentBarrier());
  process.exitCode=4;
 }catch(error){
  if(error.code!=='RUNTIME_BARRIER_UNPROVEN'&&error.code!=='RUNTIME_BARRIER_CHANGED')process.exitCode=5;
  else process.stdout.write('NONBLOCKING_REGULAR_FD_REFUSAL');
 }
})();
`;
      const result = spawnSync(process.execPath, ["-e", worker], {
        input: JSON.stringify({
          options: { ...f.options, writer: undefined },
          request: f.request,
          kind,
        }),
        encoding: "utf8",
        timeout: 5_000,
      });
      assert.equal(result.error, undefined, `${kind}: ${result.error}`);
      assert.equal(result.status, 0, `${kind}: ${result.stderr}`);
      assert.match(result.stdout, /NONBLOCKING_REGULAR_FD_REFUSAL/);
      assert.equal(fs.existsSync(path.join(f.directory, "writer.lock")), false);
    } finally {
      f.cleanup();
    }
  }
});

test("trusted callback errors retain their public contract instead of becoming native diagnostics", async () => {
  const f = fixture();
  try {
    const expected = Object.assign(
      new Error("Unresolved queue snapshot journal"),
      { code: "STORAGE_UNAVAILABLE" },
    );
    await assert.rejects(
      createNativeRuntimeRebaselineAuthorityPorts(
        f.options,
      ).withExclusiveBarrier(f.request, "publish-or-resume", async () => {
        throw expected;
      }),
      (error: unknown) => error === expected,
    );
  } finally {
    f.cleanup();
  }
});

test("in-flight other request marker blocks native begin", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(
      path.join(f.options.store, "runtime-rebaseline-publication.json"),
      JSON.stringify({
        version: 1,
        requestId: "other",
        expectedHead: f.request.expectedHead,
      }),
      { mode: 0o600 },
    );
    const ports = createNativeRuntimeRebaselineAuthorityPorts(f.options);
    await assert.rejects(
      ports.withExclusiveBarrier(f.request, "publish-or-resume", async () =>
        assert.fail(),
      ),
    );
    assert.equal(fs.existsSync(f.state), false);
  } finally {
    f.cleanup();
  }
});

test("failed authenticated query preserves preparing marker and never guesses absent", async () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.fault, JSON.stringify({ action: "query", fail: true }));
    const ports = createNativeRuntimeRebaselineAuthorityPorts(f.options);
    await assert.rejects(
      ports.withExclusiveBarrier(f.request, "publish-or-resume", async () =>
        assert.fail(),
      ),
    );
    assert.equal(fs.existsSync(f.state), false);
    assert.ok(
      fs.existsSync(
        path.join(f.options.store, "runtime-rebaseline-publication.json"),
      ),
    );
  } finally {
    f.cleanup();
  }
});

test("another operator resumes frozen writer/initiator without a second native begin", async () => {
  const f = fixture();
  try {
    const first = createNativeRuntimeRebaselineAuthorityPorts(f.options);
    let before: unknown;
    await first.withExclusiveBarrier(
      f.request,
      "publish-or-resume",
      async (lease) => {
        before = await lease.verifyCurrentBarrier();
      },
    );
    const resumeOptions = {
      ...f.options,
      operatorId: "operator-two",
      writer: {
        async withExclusiveWriter<T>(
          work: (lease: {
            generation: string;
            assertHeld(): void;
          }) => Promise<T>,
        ) {
          return f.options.writer.withExclusiveWriter((lease) =>
            work({ generation: "writer-two", assertHeld: lease.assertHeld }),
          );
        },
      },
    };
    fs.writeFileSync(f.fault, JSON.stringify({ action: "begin", fail: true }));
    await createNativeRuntimeRebaselineAuthorityPorts(
      resumeOptions,
    ).withExclusiveBarrier(f.request, "publish-or-resume", async (lease) => {
      assert.equal(lease.initiatorOperatorId, "operator-one");
      assert.deepEqual(await lease.verifyCurrentBarrier(), before);
    });
  } finally {
    f.cleanup();
  }
});

test("changed package blocks re-observation, preserving the durable marker", async () => {
  const f = fixture();
  try {
    const ports = createNativeRuntimeRebaselineAuthorityPorts(f.options);
    await ports.withExclusiveBarrier(
      f.request,
      "publish-or-resume",
      async (lease) => {
        fs.appendFileSync(
          path.join(f.directory, "lib", "rebaseline_fence.py"),
          "# changed",
        );
        await assert.rejects(lease.verifyCurrentBarrier());
      },
    );
    assert.ok(
      fs.existsSync(
        path.join(f.options.store, "runtime-rebaseline-publication.json"),
      ),
    );
  } finally {
    f.cleanup();
  }
});

test("actual Linux publisher death leaves durable preparing marker and frozen native intent for another operator", async () => {
  const f = fixture();
  const moduleFile =
    require.resolve("../packages/node-adapters/src/execution/runtime-rebaseline-native");
  const worker = spawn(
    process.execPath,
    [
      "-e",
      `
const fs=require('node:fs'),path=require('node:path');
const {createNativeRuntimeRebaselineAuthorityPorts}=require(${JSON.stringify(moduleFile)});
let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',async()=>{
const {options,request}=JSON.parse(text);
options.writer={async withExclusiveWriter(work){
const file=path.join(options.evidenceDirectory,'writer.lock'),fd=fs.openSync(file,'wx',0o600);
try{return await work({generation:'crashed-writer',assertHeld(){if(fs.fstatSync(fd).ino!==fs.statSync(file).ino)throw Error('writer lost');}});}
finally{fs.closeSync(fd);fs.unlinkSync(file);}
}};
await createNativeRuntimeRebaselineAuthorityPorts(options).withExclusiveBarrier(request,"publish-or-resume",async lease=>{
await lease.verifyCurrentBarrier();process.stdout.write('DURABLE_PENDING\\n');
setInterval(()=>{},1000);await new Promise(()=>{});
});
});
`,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exit = new Promise<void>((resolve) =>
    worker.once("close", () => resolve()),
  );
  try {
    const ready = new Promise<void>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(
        () => reject(new Error("Owned publisher did not reach barrier")),
        10_000,
      );
      worker.on("error", reject);
      worker.stdout.on("data", (data: Buffer) => {
        out += data.toString();
        if (out.includes("DURABLE_PENDING")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    worker.stdin.end(
      JSON.stringify({
        options: { ...f.options, writer: undefined },
        request: f.request,
      }),
    );
    await ready;
    await assert.rejects(
      createNativeRuntimeRebaselineAuthorityPorts(
        f.options,
      ).withExclusiveBarrier(f.request, "publish-or-resume", async () =>
        assert.fail("Concurrent writer admitted"),
      ),
    );
    worker.kill("SIGKILL");
    await exit;
    assert.ok(
      fs.existsSync(
        path.join(f.options.store, "runtime-rebaseline-publication.json"),
      ),
    );
    const frozen = JSON.parse(fs.readFileSync(f.state, "utf8"));
    assert.equal(frozen.state, "pending");
    assert.equal(frozen.binding.writerGeneration, "crashed-writer");
    // This fixture's O_EXCL writer file is not production locking. Recover only
    // our exact abandoned file after the owned publisher's confirmed death.
    fs.unlinkSync(path.join(f.directory, "writer.lock"));
    f.options.operatorId = "operator-two";
    await createNativeRuntimeRebaselineAuthorityPorts(
      f.options,
    ).withExclusiveBarrier(f.request, "publish-or-resume", async (lease) => {
      const current = await lease.verifyCurrentBarrier();
      assert.equal(lease.initiatorOperatorId, "operator-one");
      assert.equal(current.binding.writerGeneration, "crashed-writer");
    });
  } finally {
    worker.kill("SIGKILL");
    await exit;
    f.cleanup();
  }
});

test("POSIX OLD publishes once, exact NEW re-fsyncs and verified consume clears marker", async () => {
  const f = fixture(true);
  let interruptedPublication: NativeRuntimeActivationPublication | undefined;
  let saved:
    | {
        publication: NativeRuntimeActivationPublication;
        completion: NativeRuntimeActivationCompletion;
      }
    | undefined;
  try {
    const ports = createNativeRuntimeRebaselineAuthorityPorts(f.options);
    await ports.withExclusiveBarrier(
      f.request,
      "publish-or-resume",
      async (lease) => {
        const barrier = await lease.verifyCurrentBarrier();
        const recordDirectory = path.join(
          f.options.store,
          "runtime-rebaselines",
          f.request.requestId,
        );
        fs.mkdirSync(recordDirectory, { recursive: true, mode: 0o700 });
        const info = fs.statSync(f.options.store),
          recordFile = path.join(recordDirectory, "record.json");
        const frozen = Object.fromEntries(
          Object.entries(f.manifest).map(([name, digest]) => {
            if (digest === null) return [name, null];
            const file = path.join(recordDirectory, name);
            fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
            fs.copyFileSync(path.join(f.options.store, name), file);
            fs.chmodSync(file, 0o600);
            return [name, { path: file, sha256: digest }];
          }),
        );
        const recordBytes = JSON.stringify({
          store: f.options.store,
          storeDevice: info.dev,
          storeInode: info.ino,
          request: f.request,
          receipt: { newHead: "a".repeat(64) },
          frozen,
          evidence: barrier.evidence,
        });
        fs.writeFileSync(recordFile, recordBytes, { mode: 0o600 });
        const record = { path: recordFile, sha256: sha(recordBytes) };
        const activationFile = path.join(
          f.options.store,
          "runtime-rebaseline-head.json",
        );
        const publication = {
          store: f.options.store,
          storeDevice: info.dev,
          storeInode: info.ino,
          expectedHead: f.request.expectedHead,
          expectedFiles: f.manifest,
          activationFile,
          activationBytes: JSON.stringify({
            version: 1,
            newHead: "a".repeat(64),
            record,
          }),
          record,
        };
        const dangling = path.join(
          f.options.store,
          "physical-backend-head.json",
        );
        fs.symlinkSync(path.join(f.directory, "missing-target"), dangling);
        await assert.rejects(lease.publishActivation(publication));
        assert.equal(fs.existsSync(activationFile), false);
        fs.unlinkSync(dangling);
        const queueFile = path.join(f.options.store, "queue-state.json");
        const realLstat = fs.lstatSync;
        let removedAfterDetection = false;
        const lstatDescriptor = Object.getOwnPropertyDescriptor(
          fs,
          "lstatSync",
        )!;
        Object.defineProperty(fs, "lstatSync", {
          ...lstatDescriptor,
          value: new Proxy(realLstat, {
            apply(target, receiver, args) {
              const observed = Reflect.apply(target, receiver, args);
              if (String(args[0]) === queueFile && !removedAfterDetection) {
                removedAfterDetection = true;
                fs.unlinkSync(queueFile);
              }
              return observed;
            },
          }),
        });
        try {
          await assert.rejects(lease.publishActivation(publication));
          assert.equal(removedAfterDetection, true);
          assert.equal(fs.existsSync(activationFile), false);
        } finally {
          Object.defineProperty(fs, "lstatSync", lstatDescriptor);
          fs.writeFileSync(queueFile, "{}", { mode: 0o600 });
        }
        fs.writeFileSync(
          path.join(f.options.store, "queue-state.json"),
          '{"foreign":true}',
          { mode: 0o600 },
        );
        await assert.rejects(lease.publishActivation(publication));
        assert.equal(fs.existsSync(activationFile), false);
        fs.writeFileSync(path.join(f.options.store, "queue-state.json"), "{}", {
          mode: 0o600,
        });
        const realFsync = fs.fsyncSync;
        let directoryFailure = false;
        fs.fsyncSync = (fd: number) => {
          const held = fs.fstatSync(fd);
          if (
            held.isDirectory() &&
            held.ino === info.ino &&
            held.dev === info.dev &&
            fs.existsSync(activationFile)
          ) {
            directoryFailure = true;
            throw Object.assign(new Error("Owned directory durability fault"), {
              code: "EIO",
            });
          }
          return realFsync(fd);
        };
        try {
          await assert.rejects(lease.publishActivation(publication));
          assert.equal(directoryFailure, true);
          assert.ok(fs.existsSync(activationFile));
          assert.equal(
            JSON.parse(fs.readFileSync(f.state, "utf8")).state,
            "pending",
          );
          assert.ok(
            fs.existsSync(
              path.join(f.options.store, "runtime-rebaseline-publication.json"),
            ),
          );
        } finally {
          fs.fsyncSync = realFsync;
        }
        const published = fs.statSync(activationFile);
        await lease.publishActivation(publication);
        assert.equal(fs.statSync(activationFile).ino, published.ino);
        fs.writeFileSync(f.fault, JSON.stringify({ corruptReceipt: true }));
        await assert.rejects(lease.consumeActivation(publication));
        assert.ok(
          fs.existsSync(
            path.join(f.options.store, "runtime-rebaseline-publication.json"),
          ),
        );
        fs.unlinkSync(f.fault);
        interruptedPublication = publication;
      },
    );
    assert.ok(interruptedPublication);
    fs.writeFileSync(
      f.fault,
      JSON.stringify({ action: "consume", fail: true }),
    );
    const consumedState = JSON.parse(fs.readFileSync(f.state, "utf8"));
    consumedState.activeGrantCount = 1;
    consumedState.admissionCount = 2;
    fs.writeFileSync(f.state, JSON.stringify(consumedState));
    await createNativeRuntimeRebaselineAuthorityPorts(
      f.options,
    ).withExclusiveBarrier(f.request, "publish-or-resume", async (lease) => {
      assert.equal(lease.fenceState, "consumed");
      await assert.rejects(lease.verifyCurrentBarrier());
      const publication = interruptedPublication!;
      const activationFile = publication.activationFile;
      const exactNew = fs.readFileSync(activationFile);
      for (const wrong of [null, Buffer.from('{"foreign":"head"}')]) {
        if (wrong === null) fs.unlinkSync(activationFile);
        else fs.writeFileSync(activationFile, wrong, { mode: 0o600 });
        await assert.rejects(lease.publishActivation(publication));
        if (wrong === null) assert.equal(fs.existsSync(activationFile), false);
        else assert.deepEqual(fs.readFileSync(activationFile), wrong);
        fs.writeFileSync(activationFile, exactNew, { mode: 0o600 });
      }
      const published = fs.statSync(activationFile);
      await lease.publishActivation(publication);
      const result = await lease.consumeActivation(publication);
      assert.equal(
        result.nativeReceipt.kind,
        "native-runtime-rebaseline-consume-v1",
      );
      assert.equal(
        result.nativeReceipt.reference.sha256,
        sha(fs.readFileSync(result.nativeReceipt.reference.path)),
      );
      await lease.verifyNativeConsumeReceipt(publication, result);
      await lease.verifyNativeConsumeReceipt(publication, result);
      saved = { publication, completion: result };
      assert.deepEqual(result.binding, {
        requestId: f.request.requestId,
        newHead: "a".repeat(64),
        publicationDigest: sha(JSON.stringify(publication)),
        initiatorOperatorId: "operator-one",
      });
      assert.equal(fs.statSync(activationFile).ino, published.ino);
      assert.equal(
        fs.existsSync(
          path.join(f.options.store, "runtime-rebaseline-publication.json"),
        ),
        false,
      );
      assert.equal(
        JSON.parse(fs.readFileSync(f.state, "utf8")).state,
        "consumed",
      );
      for (const ref of result.evidence)
        assert.equal(sha(fs.readFileSync(ref.path)), ref.sha256);
    });
    assert.ok(saved);
    const { publication, completion } = saved;
    f.options.operatorId = "operator-two";
    const before = fs.statSync(publication.activationFile);
    // The native fixture fails consume if a completed query attempts it.
    fs.writeFileSync(
      f.fault,
      JSON.stringify({ action: "consume", fail: true }),
    );
    await createNativeRuntimeRebaselineAuthorityPorts(
      f.options,
    ).withExclusiveBarrier(f.request, "verify-completed", async (lease) => {
      const projectionOnly = {
        binding: completion.binding,
        evidence: completion.evidence,
      };
      await assert.rejects(
        lease.verifyNativeConsumeReceipt(
          publication,
          projectionOnly as NativeRuntimeActivationCompletion,
        ),
      );
      await lease.verifyNativeConsumeReceipt(publication, completion);
    });
    assert.equal(fs.statSync(publication.activationFile).ino, before.ino);
    assert.equal(
      fs.existsSync(
        path.join(f.options.store, "runtime-rebaseline-publication.json"),
      ),
      false,
    );
    const actions = fs.readFileSync(f.trace, "utf8").trim().split("\n");
    assert.equal(actions.filter((action) => action === "begin").length, 1);
    assert.equal(actions.filter((action) => action === "consume").length, 1);
    fs.unlinkSync(f.state);
    await assert.rejects(
      createNativeRuntimeRebaselineAuthorityPorts(
        f.options,
      ).withExclusiveBarrier(f.request, "verify-completed", async () =>
        assert.fail("ABSENT started a completed verification"),
      ),
    );
    assert.equal(fs.existsSync(f.state), false);
    assert.equal(
      fs.existsSync(
        path.join(f.options.store, "runtime-rebaseline-publication.json"),
      ),
      false,
    );
    assert.equal(fs.statSync(publication.activationFile).ino, before.ino);
  } finally {
    f.cleanup();
  }
});

const nativePython = process.env["FMCAD_TEST_NATIVE_PYTHON"];
const nativePythonWin = process.env["FMCAD_TEST_NATIVE_PYTHON_WIN"];
const nativeRoot = process.env["FMCAD_TEST_NATIVE_DIRECTORY"];
const nativeRootWin = process.env["FMCAD_TEST_NATIVE_DIRECTORY_WIN"];
const nativeLocalAppData = process.env["FMCAD_TEST_NATIVE_LOCALAPPDATA"];
const coreModule =
  process.env["FMCAD_TEST_RUNTIME_REBASELINE_CORE"] ??
  path.join(process.cwd(), "src/queue-runtime-rebaseline.js");

test(
  "actual administrative core composes the native adapter, preserves UNKNOWN bytes and authenticates completed reopen",
  {
    skip:
      !fs.existsSync(coreModule) &&
      "Requires the integrated administrative core or an explicitly pinned candidate",
  },
  async () => {
    const f = fixture();
    try {
      const core = createRequire(__filename)(coreModule) as {
        literalRuntimeHead(directory: string): { digest: string };
        createRuntimeRebaselineAuthority(
          ports: ReturnType<typeof createNativeRuntimeRebaselineAuthorityPorts>,
        ): unknown;
        rebaselineRuntime(
          directory: string,
          request: typeof f.request,
          authority: unknown,
        ): Promise<Record<string, unknown>>;
        runtimeRebaselineRoot(
          directory: string,
          authority: unknown,
        ): Promise<unknown>;
      };
      const snapshot = JSON.stringify({
        version: 1,
        jobs: {
          uncertain: {
            id: "uncertain",
            state: "unknown",
            request: { kind: "run" },
          },
          queued: {
            id: "queued",
            state: "queued",
            request: { kind: "command" },
          },
          terminal: { id: "terminal", state: "succeeded" },
        },
        quarantined: { uncertain: { target: null } },
      });
      fs.writeFileSync(
        path.join(f.options.store, "queue-state.json"),
        snapshot,
        { mode: 0o600 },
      );
      f.request.expectedHead = core.literalRuntimeHead(f.options.store).digest;
      const ports = createNativeRuntimeRebaselineAuthorityPorts(f.options);
      const descriptor: PhysicalGenerationDescriptor = {
        kind: "fmcad-physical-grant",
        version: 1,
        handoffId: f.options.pins.handoffId,
        generation: f.options.pins.generation,
        physicalRuntime: {
          ...f.options.pins.process,
          version: f.options.runtimeVersion,
          source: f.options.pins.source,
          build: f.options.pins.build,
        },
        endpointURL: f.options.pins.endpoint,
        brokerOwner: {
          pid: process.pid,
          birth: "owned-broker-birth",
          nonce: "owned-broker",
          clientId: "owned-client",
          queueDirectory: f.options.store,
        },
      };
      assert.equal(await ports.getVerifiedActivation(descriptor), undefined);
      const authority = core.createRuntimeRebaselineAuthority(ports);
      const receipt = await core.rebaselineRuntime(
        f.options.store,
        f.request,
        authority,
      );
      assert.equal(receipt["history"], "preserved_unproven");
      assert.equal(receipt["grantIssued"], false);
      assert.equal(receipt["sdkSubmitted"], false);
      assert.equal(
        fs.readFileSync(path.join(f.options.store, "queue-state.json"), "utf8"),
        snapshot,
      );
      assert.equal(
        JSON.parse(fs.readFileSync(f.state, "utf8")).state,
        "consumed",
      );
      const nativeState = JSON.parse(fs.readFileSync(f.state, "utf8"));
      const approved = JSON.parse(nativeState.receiptJson).activation;
      assert.deepEqual(await ports.getVerifiedActivation(descriptor), {
        requestId: approved.requestId,
        fenceNonce: approved.fenceNonce,
        newHead: approved.newHead,
        publicationDigest: approved.publicationDigest,
        receiptDigest: sha(nativeState.receiptJson),
      });
      await assert.rejects(
        ports.getVerifiedActivation({
          ...descriptor,
          brokerOwner: {
            ...descriptor.brokerOwner,
            queueDirectory: "/other-store",
          },
        }),
      );
      const headFile = path.join(
        f.options.store,
        "runtime-rebaseline-head.json",
      );
      const inode = fs.statSync(headFile).ino;
      f.options.operatorId = "operator-two";
      fs.writeFileSync(
        f.fault,
        JSON.stringify({ action: "consume", fail: true }),
      );
      const resumer = core.createRuntimeRebaselineAuthority(
        createNativeRuntimeRebaselineAuthorityPorts(f.options),
      );
      fs.unlinkSync(
        path.join(
          f.options.store,
          "runtime-rebaselines",
          f.request.requestId,
          "completion.json",
        ),
      );
      const nativeConsumed = JSON.parse(fs.readFileSync(f.state, "utf8"));
      nativeConsumed.activeGrantCount = 1;
      nativeConsumed.admissionCount = 2;
      fs.writeFileSync(f.state, JSON.stringify(nativeConsumed));
      await assert.rejects(
        core.runtimeRebaselineRoot(f.options.store, resumer),
      );
      assert.deepEqual(
        await core.rebaselineRuntime(f.options.store, f.request, resumer),
        receipt,
      );
      assert.ok(await core.runtimeRebaselineRoot(f.options.store, resumer));
      assert.deepEqual(
        await core.rebaselineRuntime(f.options.store, f.request, resumer),
        receipt,
      );
      assert.equal(fs.statSync(headFile).ino, inode);
      assert.equal(
        fs.existsSync(
          path.join(f.options.store, "runtime-rebaseline-publication.json"),
        ),
        false,
      );
      const actionsBeforeAbsent = fs
        .readFileSync(f.trace, "utf8")
        .trim()
        .split("\n");
      assert.equal(
        actionsBeforeAbsent.filter((action) => action === "begin").length,
        1,
      );
      assert.equal(
        actionsBeforeAbsent.filter((action) => action === "consume").length,
        1,
      );
      fs.unlinkSync(f.state);
      await assert.rejects(ports.getVerifiedActivation(descriptor));
      await assert.rejects(
        core.runtimeRebaselineRoot(f.options.store, resumer),
      );
      assert.equal(fs.existsSync(f.state), false);
      assert.equal(fs.statSync(headFile).ino, inode);
      assert.equal(
        fs.existsSync(
          path.join(f.options.store, "runtime-rebaseline-publication.json"),
        ),
        false,
      );
    } finally {
      f.cleanup();
    }
  },
);

test(
  "actual isolated Windows helper reaches owned SQLite pending fence; another native issuer remains blocked after helper exit",
  {
    skip:
      !nativePython ||
      !nativePythonWin ||
      !nativeRoot ||
      !nativeRootWin ||
      !nativeLocalAppData
        ? "Requires explicitly configured owned Windows filesystem fixture; no Fusion"
        : false,
  },
  async () => {
    const f = fixture();
    const root = path.join(nativeRoot!, path.basename(f.directory));
    const winRoot = path.win32.join(nativeRootWin!, path.basename(f.directory));
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, "lib"));
    const identityScript = `
import ctypes,json,os,sys
from ctypes import wintypes as wt
k=ctypes.WinDLL("kernel32",use_last_error=True)
k.GetCurrentProcess.restype=wt.HANDLE
k.GetProcessTimes.argtypes=[wt.HANDLE,ctypes.POINTER(wt.FILETIME),ctypes.POINTER(wt.FILETIME),ctypes.POINTER(wt.FILETIME),ctypes.POINTER(wt.FILETIME)]
t=[wt.FILETIME() for _ in range(4)]
assert k.GetProcessTimes(k.GetCurrentProcess(),*(ctypes.byref(v) for v in t))
print(json.dumps({"pid":os.getpid(),"birth":str((t[0].dwHighDateTime<<32)|t[0].dwLowDateTime)}),flush=True)
sys.stdin.buffer.read()
`;
    const owner = spawn(
      nativePython!,
      ["-I", "-S", "-B", "-c", identityScript],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const ownerExit = new Promise<void>((resolve) =>
      owner.once("close", () => resolve()),
    );
    try {
      const identity = await new Promise<{ pid: number; birth: string }>(
        (resolve, reject) => {
          let output = "";
          const timer = setTimeout(() => {
            owner.kill();
            reject(new Error("Owned process timeout"));
          }, 10_000);
          owner.on("error", reject);
          owner.stdout.on("data", (data: Buffer) => {
            output += data.toString();
            if (output.includes("\n")) {
              clearTimeout(timer);
              resolve(JSON.parse(output));
            }
          });
        },
      );
      const retiredRun = spawnSync(
        nativePython!,
        ["-I", "-S", "-B", "-c", identityScript],
        { input: "", encoding: "utf8" },
      );
      assert.equal(retiredRun.status, 0, retiredRun.stderr);
      const retired = JSON.parse(retiredRun.stdout);
      const database = winRoot + "-owned.sqlite3";
      const options = f.options;
      options.pins.process = identity;
      const coldBytes = JSON.stringify({
        ...identity,
        exe: "C:\\OwnedOfflineProcess.exe",
      });
      fs.writeFileSync(options.originalEvidence.coldProcess.path, coldBytes);
      options.originalEvidence.coldProcess.sha256 = sha(coldBytes);
      options.pins.admissionStore = database;
      const preservedRows = JSON.parse(
        fs.readFileSync(options.originalEvidence.preservedRows.path, "utf8"),
      );
      preservedRows.databasePath = database;
      const preservedBytes = JSON.stringify(preservedRows);
      fs.writeFileSync(
        options.originalEvidence.preservedRows.path,
        preservedBytes,
      );
      options.originalEvidence.preservedRows.sha256 = sha(preservedBytes);
      options.publicationAuthority.nativeOperatorFile =
        winRoot + "-operator.json";
      fs.writeFileSync(
        root + "-operator.json",
        JSON.stringify({
          database,
          runtime: {
            handoffId: options.pins.handoffId,
            generation: options.pins.generation,
            physicalRuntime: {
              ...identity,
              version: options.runtimeVersion,
              source: options.pins.source,
              build: options.pins.build,
            },
            endpointURL: options.pins.endpoint,
          },
        }),
      );
      const retiredBytes = JSON.stringify({
        exited: true,
        oldPidPresent: false,
        forceUsed: false,
        oldPid: retired.pid,
        oldBirth: retired.birth,
      });
      fs.writeFileSync(
        options.originalEvidence.retiredProcess.path,
        retiredBytes,
      );
      options.originalEvidence.retiredProcess.sha256 = sha(retiredBytes);
      const provision = path.join(root, "provision.json");
      fs.writeFileSync(
        provision,
        JSON.stringify({
          ...identity,
          source: options.pins.source,
          build: options.pins.build,
          ...options.pins.generation,
        }),
      );
      const sources = {
        "lib/__init__.py": "",
        "lib/admission_json.py":
          "import json\ndef decode_json(raw):\n    return json.loads(raw)\n",
        "lib/physical_authority.py": `
from pathlib import Path
import json
def private_directory(directory):
    Path(directory).mkdir(parents=True,exist_ok=True)
def _read_private_bytes(file):
    raw=Path(file).read_bytes()
    trigger=Path(${JSON.stringify(winRoot + "-swap-operator")})
    if str(file)==${JSON.stringify(winRoot + "-operator.json")} and trigger.exists():
        trigger.unlink()
        wrong=json.loads(raw);wrong["database"]=${JSON.stringify(winRoot + "-other.sqlite3")}
        Path(file).write_text(json.dumps(wrong))
    return raw
`,
        "lib/request_admission.py":
          "# Owned fake SQLite issuer only, not production AdmissionStore\n",
        "lib/rebaseline_fence.py": `
import json,sqlite3
class OperatorAuthority:
    def __init__(self,profile):
        self.profile=profile
def execute(authority,q,action):
    c=sqlite3.connect(authority.profile["database"],isolation_level=None)
    c.execute("PRAGMA synchronous=FULL")
    c.execute("CREATE TABLE IF NOT EXISTS fence (body TEXT NOT NULL)")
    row=c.execute("SELECT body FROM fence").fetchone()
    if action=="begin" and row is None:
        c.execute("BEGIN IMMEDIATE")
        value={"kind":"fmcad-provision-fence","version":1,"state":"pending","binding":{
      "requestId":q["requestId"],"fenceNonce":"owned-sqlite-nonce","handoffId":q["handoffId"],
      "generation":${JSON.stringify(options.pins.generation)},
      "physicalRuntime":${JSON.stringify({ ...identity, version: options.runtimeVersion, source: options.pins.source, build: options.pins.build })},
      "endpointURL":${JSON.stringify(options.pins.endpoint)},
      "store":q["store"],"oldHead":q["expectedHead"],"intentReferences":q["intentReferences"],
      "initiatorOperatorId":"operator-one","writerGeneration":q["writerGeneration"]}}
        c.execute("INSERT INTO fence VALUES (?)",(json.dumps(value),));c.commit()
        row=(json.dumps(value),)
    if row is None:
        value={"kind":"fmcad-provision-fence","version":1,"state":"absent","requestId":q["requestId"]}
    else:
        value=json.loads(row[0])
    c.close()
    return value
def begin_fence(authority,q): return execute(authority,q,"begin")
def query_fence(authority,q): return execute(authority,q,"query")
def consume_fence(authority,q): raise RuntimeError("Not used by owned SQLite guard fixture")
`,
      };
      const packageFiles: Record<string, string> = {};
      for (const [name, source] of Object.entries(sources)) {
        fs.writeFileSync(path.join(root, name), source);
        packageFiles[name] = sha(source);
      }
      // The provision is deliberately outside the package; full package-set
      // verification must not silently omit arbitrary files inside its root.
      const provisionOutside = root + "-provision.json";
      fs.renameSync(provision, provisionOutside);
      options.native = {
        ...options.native,
        nativePython: nativePythonWin!,
        mappedNativePython: nativePython!,
        nativePythonSha256: sha(fs.readFileSync(nativePython!)),
        installedForkDirectory: winRoot,
        mappedInstalledForkDirectory: root,
        installedPackageFiles: packageFiles,
        provisionPath: winRoot + "-provision.json",
        localAppData: nativeLocalAppData!,
        nativePrivateDirectory: winRoot + "-mailbox",
        mappedPrivateDirectory: root + "-mailbox",
      };
      // SQLite must likewise remain outside the pinned package tree.
      const ports = createNativeRuntimeRebaselineAuthorityPorts(options);
      await ports.withExclusiveBarrier(
        f.request,
        "publish-or-resume",
        async (lease) => {
          const current = await lease.verifyCurrentBarrier();
          assert.equal(current.binding.process.pid, identity.pid);
          assert.equal(current.binding.grantCount, 0);
        },
      );
      // All verifier subprocesses have exited. A fresh native SQLite connection
      // still observes pending and denies its owned fake issuance transaction.
      const issuer = spawnSync(
        nativePython!,
        [
          "-I",
          "-S",
          "-B",
          "-c",
          `
import sqlite3,sys,json
c=sqlite3.connect(sys.argv[1],isolation_level=None);c.execute("BEGIN IMMEDIATE")
row=c.execute("SELECT body FROM fence").fetchone()
assert json.loads(row[0])["state"]=="pending"
c.rollback()
print("OWNED_ISSUANCE_DENIED_AFTER_VERIFIER_EXIT")
`,
          winRoot + "-owned.sqlite3",
        ],
        { encoding: "utf8" },
      );
      assert.equal(issuer.status, 0, issuer.stderr);
      assert.match(issuer.stdout, /OWNED_ISSUANCE_DENIED_AFTER_VERIFIER_EXIT/);
      const operatorBytes = fs.readFileSync(root + "-operator.json");
      fs.writeFileSync(
        root + "-swap-operator",
        "swap after the exact verified read",
      );
      await ports.withExclusiveBarrier(
        f.request,
        "publish-or-resume",
        async (lease) => {
          assert.equal(lease.fenceState, "pending");
        },
      );
      assert.equal(fs.existsSync(root + "-other.sqlite3"), false);
      assert.equal(
        JSON.parse(fs.readFileSync(root + "-operator.json", "utf8")).database,
        winRoot + "-other.sqlite3",
      );
      fs.writeFileSync(root + "-operator.json", operatorBytes);
      const wrongStoreOperator = JSON.parse(operatorBytes.toString("utf8"));
      wrongStoreOperator.database = winRoot + "-other.sqlite3";
      fs.writeFileSync(
        root + "-operator.json",
        JSON.stringify(wrongStoreOperator),
      );
      await assert.rejects(
        ports.withExclusiveBarrier(f.request, "publish-or-resume", async () =>
          assert.fail("Wrong operator AdmissionStore accepted"),
        ),
      );
      fs.writeFileSync(root + "-operator.json", operatorBytes);
      const falselyRetired = JSON.stringify({
        exited: true,
        oldPidPresent: false,
        forceUsed: false,
        oldPid: identity.pid,
        oldBirth: identity.birth,
      });
      fs.writeFileSync(
        options.originalEvidence.retiredProcess.path,
        falselyRetired,
      );
      options.originalEvidence.retiredProcess.sha256 = sha(falselyRetired);
      // Independently observe the still-live owned process. An archived JSON
      // retirement verdict alone must never establish the current barrier.
      await assert.rejects(
        createNativeRuntimeRebaselineAuthorityPorts(
          options,
        ).withExclusiveBarrier(f.request, "publish-or-resume", async () =>
          assert.fail("Live retired process accepted"),
        ),
      );
    } finally {
      owner.stdin.end();
      await ownerExit;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(root + "-mailbox", { recursive: true, force: true });
      for (const suffix of [
        "-provision.json",
        "-operator.json",
        "-swap-operator",
        "-other.sqlite3",
        "-owned.sqlite3",
        "-owned.sqlite3-journal",
      ])
        fs.rmSync(root + suffix, { force: true });
      f.cleanup();
    }
  },
);
