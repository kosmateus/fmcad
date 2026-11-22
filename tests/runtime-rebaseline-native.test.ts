import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import {
  createNativeRuntimeRebaselineAuthorityPorts,
  type NativeRuntimeRebaselineOptions,
} from "../packages/node-adapters/src/execution/runtime-rebaseline-native";

const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** Separate executable, persistent fake issuer store, actual Linux files.
 * No Fusion, production DB, grant or SDK call is used by this fixture. */
function fixture() {
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
  const scriptFile = path.join(directory, "actual-transmitted-script.py");
  fs.writeFileSync(
    executable,
    `#!${process.execPath}
const fs=require('node:fs'),crypto=require('node:crypto');
let raw='';process.stdin.on('data',b=>raw+=b);
process.stdin.on('end',()=>{
const e=JSON.parse(raw),q=JSON.parse(e.requestJson);
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
  const names = [
    "physical-backend-head.json",
    "isolated-admission-epoch.json",
    "instance.json",
    "queue-state.json",
    "runtime-rebaseline-head.json",
  ];
  const manifest = Object.fromEntries(
    names.map((name) => [name, name === "queue-state.json" ? sha("{}") : null]),
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
    await ports.withExclusiveBarrier(f.request, async (lease) => {
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
    });
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
      ports.withExclusiveBarrier(f.request, async () => assert.fail()),
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
      ports.withExclusiveBarrier(f.request, async () => assert.fail()),
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
    await first.withExclusiveBarrier(f.request, async (lease) => {
      before = await lease.verifyCurrentBarrier();
    });
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
    ).withExclusiveBarrier(f.request, async (lease) => {
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
    await ports.withExclusiveBarrier(f.request, async (lease) => {
      fs.appendFileSync(
        path.join(f.directory, "lib", "rebaseline_fence.py"),
        "# changed",
      );
      await assert.rejects(lease.verifyCurrentBarrier());
    });
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
await createNativeRuntimeRebaselineAuthorityPorts(options).withExclusiveBarrier(request,async lease=>{
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
    ).withExclusiveBarrier(f.request, async (lease) => {
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
  const f = fixture();
  try {
    const ports = createNativeRuntimeRebaselineAuthorityPorts(f.options);
    await ports.withExclusiveBarrier(f.request, async (lease) => {
      const barrier = await lease.verifyCurrentBarrier();
      const recordDirectory = path.join(
        f.options.store,
        "runtime-rebaselines",
        f.request.requestId,
      );
      fs.mkdirSync(recordDirectory, { recursive: true, mode: 0o700 });
      const info = fs.statSync(f.options.store),
        recordFile = path.join(recordDirectory, "record.json");
      const frozenQueue = path.join(recordDirectory, "queue-state.json");
      fs.writeFileSync(frozenQueue, "{}", { mode: 0o600 });
      const recordBytes = JSON.stringify({
        store: f.options.store,
        storeDevice: info.dev,
        storeInode: info.ino,
        request: f.request,
        receipt: { newHead: "a".repeat(64) },
        frozen: {
          "queue-state.json": { path: frozenQueue, sha256: sha("{}") },
        },
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
      await lease.publishActivation(publication);
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
      const result = await lease.consumeActivation(publication);
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
  } finally {
    f.cleanup();
  }
});

const nativePython = process.env["FMCAD_TEST_NATIVE_PYTHON"];
const nativePythonWin = process.env["FMCAD_TEST_NATIVE_PYTHON_WIN"];
const nativeRoot = process.env["FMCAD_TEST_NATIVE_DIRECTORY"];
const nativeRootWin = process.env["FMCAD_TEST_NATIVE_DIRECTORY_WIN"];
const nativeLocalAppData = process.env["FMCAD_TEST_NATIVE_LOCALAPPDATA"];

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
        "lib/physical_authority.py": `
from pathlib import Path
def private_directory(directory):
    Path(directory).mkdir(parents=True,exist_ok=True)
def _read_private_bytes(file):
    return Path(file).read_bytes()
`,
        "lib/request_admission.py":
          "# Owned fake SQLite issuer only, not production AdmissionStore\n",
        "lib/rebaseline_fence.py": `
import argparse,json,sqlite3
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument("action");p.add_argument("--operator-file");p.add_argument("--request")
a=p.parse_args();q=json.loads(Path(a.request).read_bytes())
c=sqlite3.connect(${JSON.stringify(database)},isolation_level=None)
c.execute("PRAGMA synchronous=FULL")
c.execute("CREATE TABLE IF NOT EXISTS fence (body TEXT NOT NULL)")
row=c.execute("SELECT body FROM fence").fetchone()
if a.action=="begin" and row is None:
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
print(json.dumps(value))
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
      await ports.withExclusiveBarrier(f.request, async (lease) => {
        const current = await lease.verifyCurrentBarrier();
        assert.equal(current.binding.process.pid, identity.pid);
        assert.equal(current.binding.grantCount, 0);
      });
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
    } finally {
      owner.stdin.end();
      await ownerExit;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(root + "-mailbox", { recursive: true, force: true });
      for (const suffix of [
        "-provision.json",
        "-owned.sqlite3",
        "-owned.sqlite3-journal",
      ])
        fs.rmSync(root + suffix, { force: true });
      f.cleanup();
    }
  },
);
