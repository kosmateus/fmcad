import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import {
  createNativeRuntimeRebaselineReaderPorts,
  type NativeRuntimeRebaselineReaderOptions,
} from "../packages/node-adapters/src/execution/runtime-rebaseline-reader";
import type {
  NativeRuntimeActivationPublication,
  NativeRuntimeActivationCompletion,
} from "../packages/node-adapters/src/execution/runtime-rebaseline-native";
import type { PhysicalGenerationDescriptor } from "../packages/node-adapters/src/execution/physical-generation";
import type * as Core from "../src/queue-runtime-rebaseline";

const load = createRequire(__filename);
const repo = process.cwd();
const core = load(
  path.join(repo, "src/queue-runtime-rebaseline"),
) as typeof Core;
const { QueueState } = load(
  path.join(repo, "src/queue-state"),
) as typeof import("../src/queue-state");
const sha = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Actual core publication + owned SQLite receipt issuer fixture. The private
 * subprocess runs on Linux, not Fusion/Windows. It validates/compiles the exact
 * transmitted QUERY script and reads its pre-existing database with mode=ro.
 * Signing and initial writes belong only to this explicit fixture producer. */
async function fixture(t: TestContext, prefix = "consumed-reader-") {
  const directory = fs.mkdtempSync(
    path.join(
      process.env["FMCAD_READER_CHILD_BASE"] ?? "/tmp/opencode",
      prefix,
    ),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = path.join(directory, "store");
  fs.mkdirSync(store, { mode: 0o700 });
  const queue = new QueueState(store);
  const job = queue.submit({
    kind: "rpc",
    clientId: "historical-author",
    requestId: "old-unknown",
    timeoutMs: 1000,
    payload: { jsonrpc: "2.0", method: "mutation", id: "old" },
  });
  const jobId = job["id"];
  assert.equal(typeof jobId, "string");
  assert.ok(typeof jobId === "string");
  queue.next();
  queue.markDispatch(jobId, { rpcCount: 1, completedCount: 0 });
  queue.block(jobId, { code: "UNKNOWN" });
  const history = fs.readFileSync(path.join(store, "queue-state.json"));
  const write = (file: string, bytes: string | Buffer) => {
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return { path: file, sha256: sha(bytes) };
  };
  const pins: Core.RuntimePins = {
    handoffId: "owned-handoff",
    admissionStore: "C:\\owned\\admission.sqlite3",
    generation: { instance: "current-instance", epoch: "current-epoch" },
    process: { pid: 456, birth: "owned-current-birth" },
    source: "owned-source",
    build: "owned-build",
    endpoint: "http://127.0.0.1:8765/mcp",
  };
  const binding: Core.RuntimeBarrierBinding = {
    ...pins,
    retiredProcess: { pid: 123, birth: "owned-retired-birth" },
    retirement: "process_dead",
    ingress: "pinned_all_sdk_ingress",
    grantCount: 0,
    admissionCount: 0,
    writerGeneration: "owned-writer",
  };
  const attestation = write(
    path.join(directory, "barrier.json"),
    JSON.stringify(binding),
  );
  const key = Buffer.alloc(32, 7),
    keyRef = write(path.join(directory, "key"), key);
  const database = path.join(directory, "issuer.sqlite3");
  const stateFile = path.join(directory, "fault.json");
  write(stateFile, "{}");
  const trace = path.join(directory, "trace");
  write(trace, "");
  const packageRoot = path.join(directory, "package");
  fs.mkdirSync(packageRoot, { mode: 0o700 });
  fs.mkdirSync(path.join(packageRoot, "lib"), { mode: 0o700 });
  const packageFiles: Record<string, string> = {};
  for (const file of [
    "physical_authority.py",
    "request_admission.py",
    "rebaseline_fence.py",
    "admission_json.py",
  ]) {
    const bytes = "# owned offline package boundary fixture\n";
    fs.writeFileSync(path.join(packageRoot, "lib", file), bytes);
    packageFiles[`lib/${file}`] = sha(bytes);
  }
  const executable = path.join(directory, "private-python");
  write(
    executable,
    `#!/usr/bin/python3
import ast,json,sqlite3,sys,pathlib,time
script=sys.argv[-1]
compile(script,"<actual-query-script>","exec")
tree=ast.parse(script)
imports=[n for n in ast.walk(tree) if isinstance(n,ast.ImportFrom) and n.module=="lib.rebaseline_fence"]
assert len(imports)==1 and [n.name for n in imports[0].names]==["OperatorAuthority","query_fence"]
for n in ast.walk(tree):
 if isinstance(n,ast.Call):
  name=n.func.id if isinstance(n.func,ast.Name) else n.func.attr if isinstance(n.func,ast.Attribute) else ""
  assert name not in {"private_directory","mkdir","write_bytes","write_text","begin_fence","consume_fence","rename","unlink"}
e=json.loads(sys.stdin.buffer.readline())
assert e["action"]=="query" and "retiredProcess" not in e
q=json.loads(e["requestJson"]);assert set(q)=={"requestId"}
assert e["admissionStore"]==${JSON.stringify(pins.admissionStore)}
assert e["keyId"]=="owned-key" and e["keyDigest"]==${JSON.stringify(keyRef.sha256)}
fault=json.loads(pathlib.Path(${JSON.stringify(stateFile)}).read_bytes())
c=sqlite3.connect("file:"+${JSON.stringify(database)}+"?mode=ro",uri=True)
before=c.total_changes
row=c.execute("SELECT body FROM consumed WHERE request_id=?",(q["requestId"],)).fetchone()
assert c.total_changes==before
c.close()
value=json.loads(row[0]) if row else {"state":"absent"}
with open(${JSON.stringify(trace)},"a") as f:f.write("query\\n")
if fault.get("pause"):
 pathlib.Path(fault["ready"]).write_text("response captured")
 until=time.time()+10
 while not pathlib.Path(fault["release"]).exists() and time.time()<until:time.sleep(.01)
 assert pathlib.Path(fault["release"]).exists()
if fault.get("badMac"):value["receiptMac"]="0"*64
if fault.get("malformedMac"):value["receiptMac"]="not-a-native-mac"
if fault.get("badLiteral"):value["publicationJson"]+=" "
if fault.get("badBinding"):value["binding"]["generation"]["epoch"]="foreign"
if fault.get("badStore"):value["binding"]["store"]["path"]="/foreign-store"
print(json.dumps(value))
`,
  );
  fs.chmodSync(executable, 0o700);
  const options: NativeRuntimeRebaselineReaderOptions = {
    store,
    pins,
    runtimeVersion: "owned-version",
    native: {
      nativePython: "C:\\owned\\python.exe",
      mappedNativePython: executable,
      nativePythonSha256: sha(fs.readFileSync(executable)),
      installedForkDirectory: "C:\\owned\\package",
      mappedInstalledForkDirectory: packageRoot,
      installedPackageFiles: packageFiles,
      provisionPath: "C:\\owned\\provision.json",
      localAppData: "C:\\owned",
      nativePrivateDirectory: "C:\\owned",
    },
    publicationAuthority: {
      keyId: "owned-key",
      keyReference: keyRef,
      nativeOperatorFile: "C:\\owned\\operator.json",
    },
  };
  let publication!: NativeRuntimeActivationPublication;
  let completion!: NativeRuntimeActivationCompletion;
  let terminal!: Record<string, unknown>;
  const authority = core.createRuntimeRebaselineAuthority({
    store,
    operatorId: "owned-initiator",
    pins,
    async withExclusiveBarrier(_request, _mode, work) {
      const lock = path.join(directory, "writer.lock");
      const fd = fs.openSync(lock, "wx", 0o600);
      try {
        const assertHeld = () =>
          assert.equal(fs.fstatSync(fd).ino, fs.statSync(lock).ino);
        return await work({
          fenceState: "pending",
          initiatorOperatorId: "owned-initiator",
          assertWriterAndProvisionLock: assertHeld,
          async verifyCurrentBarrier() {
            assertHeld();
            return { binding, evidence: [attestation] };
          },
          async publishActivation(value) {
            assertHeld();
            publication = structuredClone(value);
            write(value.activationFile, value.activationBytes);
          },
          async consumeActivation(value) {
            assertHeld();
            const fence = {
              requestId: "owned-request",
              fenceNonce: "owned-native-nonce",
              handoffId: pins.handoffId,
              store: {
                path: store,
                device: value.storeDevice,
                inode: value.storeInode,
              },
              oldHead: value.expectedHead,
              generation: pins.generation,
              physicalRuntime: {
                ...pins.process,
                version: options.runtimeVersion,
                source: pins.source,
                build: pins.build,
              },
              endpointURL: pins.endpoint,
              intentReferences: [attestation],
              writerGeneration: binding.writerGeneration,
              initiatorOperatorId: "owned-initiator",
            };
            const activation = JSON.parse(value.activationBytes);
            const completionBinding = {
              requestId: "owned-request",
              newHead: activation.newHead,
              publicationDigest: sha(JSON.stringify(value)),
              initiatorOperatorId: "owned-initiator",
            };
            const receiptJson = JSON.stringify({
              kind: "fmcad-rebaseline-consumed",
              version: 1,
              fence,
              activation: {
                ...completionBinding,
                fenceNonce: fence.fenceNonce,
                record: value.record,
              },
            });
            terminal = {
              kind: "fmcad-provision-fence",
              version: 1,
              state: "consumed",
              binding: fence,
              publicationJson: JSON.stringify(value),
              receiptJson,
              receiptDigest: sha(receiptJson),
              receiptMac: createHmac("sha256", key)
                .update("fmcad-native-consume-v1\0")
                .update(receiptJson)
                .digest("hex"),
            };
            const receiptRef = write(
              path.join(directory, "consumed.json"),
              receiptJson,
            );
            const bindingRef = write(
              path.join(directory, "completion-binding.json"),
              JSON.stringify(completionBinding),
            );
            completion = {
              binding: completionBinding,
              evidence: [receiptRef, bindingRef],
              nativeReceipt: {
                kind: "native-runtime-rebaseline-consume-v1",
                reference: receiptRef,
              },
            };
            const result = spawnSync(
              "python3",
              [
                "-c",
                `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute("CREATE TABLE consumed(request_id TEXT PRIMARY KEY, body TEXT)")
c.execute("INSERT INTO consumed VALUES (?,?)",("owned-request",sys.stdin.read()));c.commit();c.close()`,
                database,
              ],
              { input: JSON.stringify(terminal), encoding: "utf8" },
            );
            assert.equal(result.status, 0, result.stderr);
            fs.chmodSync(database, 0o600);
            return completion;
          },
          async verifyNativeConsumeReceipt(value, done) {
            assertHeld();
            assert.deepEqual(value, publication);
            assert.deepEqual(done, completion);
          },
        });
      } finally {
        fs.closeSync(fd);
        fs.unlinkSync(lock);
      }
    },
  });
  const request = {
    handoffId: pins.handoffId,
    requestId: "owned-request",
    expectedHead: core.literalRuntimeHead(store).digest,
  };
  await core.rebaselineRuntime(store, request, authority);
  const descriptor: PhysicalGenerationDescriptor = {
    kind: "fmcad-physical-grant",
    version: 1,
    handoffId: pins.handoffId,
    generation: pins.generation,
    brokerOwner: {
      pid: process.pid,
      birth: "owned-broker",
      nonce: "owned-nonce",
      clientId: "new-reader",
      queueDirectory: store,
    },
    endpointURL: pins.endpoint,
    physicalRuntime: {
      ...pins.process,
      version: options.runtimeVersion,
      source: pins.source,
      build: pins.build,
    },
  };
  const ports = createNativeRuntimeRebaselineReaderPorts(options);
  const reader = core.createRuntimeRebaselineReaderAuthority(ports);
  return {
    directory,
    store,
    history,
    jobId,
    queue,
    options,
    database,
    stateFile,
    trace,
    publication,
    completion,
    terminal,
    request,
    descriptor,
    ports,
    reader,
  };
}

test("real core approves a CONSUMED root through SQLite QUERY only, preserves UNKNOWN and returns the exact activation tuple", async (t) => {
  const f = await fixture(t);
  const before = fs.readFileSync(f.database);
  const write = t.mock.method(fs, "writeFileSync", () => {
    throw new Error("Reader must not write/create evidence");
  });
  const mkdir = t.mock.method(fs, "mkdirSync", () => {
    throw new Error("Reader must not create directories");
  });
  const openSync = fs.openSync;
  const opened = t.mock.method(
    fs,
    "openSync",
    (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (typeof flags === "string") assert.match(flags, /^(r|rs|sr)$/);
      else
        assert.equal(
          flags &
            (fs.constants.O_CREAT |
              fs.constants.O_WRONLY |
              fs.constants.O_RDWR |
              fs.constants.O_TRUNC),
          0,
        );
      return openSync(file, flags, mode);
    },
  );
  const root = await core.runtimeRebaselineRoot(f.store, f.reader);
  assert.ok(root);
  assert.equal(root.record.history, "preserved_unproven");
  assert.equal(root.record.dispositions[f.jobId]?.outcome, "unknown");
  assert.deepEqual(
    fs.readFileSync(path.join(f.store, "queue-state.json")),
    f.history,
  );
  assert.deepEqual(await f.ports.getVerifiedActivation(f.descriptor), {
    requestId: f.request.requestId,
    fenceNonce: "owned-native-nonce",
    newHead: f.completion.binding.newHead,
    publicationDigest: f.completion.binding.publicationDigest,
    receiptDigest: sha(String(f.terminal["receiptJson"])),
  });
  assert.deepEqual(fs.readFileSync(f.database), before);
  assert.deepEqual(fs.readFileSync(f.trace, "utf8").trim().split("\n"), [
    "query",
    "query",
  ]);
  assert.equal(write.mock.callCount(), 0);
  assert.equal(mkdir.mock.callCount(), 0);
  write.mock.restore();
  mkdir.mock.restore();
  opened.mock.restore();
});

test("readonly authority is not a publication lease or JSON authority", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.ports.getVerifiedActivation(f.descriptor), undefined);
  await assert.rejects(
    core.rebaselineRuntime(
      f.store,
      f.request,
      JSON.parse(JSON.stringify(f.reader)),
    ),
    { code: "NOT_AUTHORIZED" },
  );
  await assert.rejects(
    core.rebaselineRuntime(f.store, f.request, JSON.parse("{}")),
    { code: "NOT_AUTHORIZED" },
  );
  await assert.rejects(
    core.runtimeRebaselineRoot(f.store, JSON.parse(JSON.stringify(f.reader))),
    { code: "NOT_AUTHORIZED" },
  );
  // A real reader brand remains distinct even when called from untyped JS.
  const invoke = core.rebaselineRuntime as (
    dir: string,
    request: Core.RuntimeRebaselineRequest,
    authority: unknown,
  ) => Promise<unknown>;
  await assert.rejects(invoke(f.store, f.request, f.reader), {
    code: "NOT_AUTHORIZED",
  });
  assert.equal(fs.readFileSync(f.trace, "utf8"), "");
});

function evolve(f: Awaited<ReturnType<typeof fixture>>, requestId: string) {
  const later = f.queue.submit({
    kind: "command",
    phased: true,
    cwd: f.directory,
    clientId: "later-owner",
    requestId,
    timeoutMs: 1000,
    argv: ["cad", "document", "status"],
    payload: {
      version: 1,
      kind: "cad",
      operation: "document.status",
      doc: "Later owned fixture",
      docId: "later-owned-document",
      data: {},
    },
  });
  const id = later["id"];
  assert.ok(typeof id === "string");
  f.queue.finishLocal(id, {
    state: "failed",
    code: "OWNED_PRE_SDK_STOP",
    executionOutcome: "not_started",
    mayHaveMutated: false,
    sdkSettled: true,
  });
  return id;
}

test("settled later queue evolution is preserved as current view, never reset to the frozen baseline", async (t) => {
  const f = await fixture(t);
  const immutableHead = fs.readFileSync(f.publication.activationFile);
  const laterId = evolve(f, "later-before-verification");
  const evolved = fs.readFileSync(path.join(f.store, "queue-state.json"));
  const root = await core.runtimeRebaselineRoot(f.store, f.reader);
  assert.ok(root);
  assert.deepEqual(root.currentFiles?.["queue-state.json"], evolved);
  assert.equal(root.record.dispositions[laterId], undefined);
  assert.equal(
    Object.hasOwn(root.snapshot["jobs"] as Record<string, unknown>, laterId),
    false,
  );
  const current = JSON.parse(
    root.currentFiles!["queue-state.json"]!.toString("utf8"),
  );
  assert.equal(current.jobs[laterId].state, "failed");
  assert.equal(current.jobs[f.jobId].state, "needs_reconciliation");
  assert.deepEqual(
    fs.readFileSync(f.publication.activationFile),
    immutableHead,
  );
  evolve(f, "later-before-issuance-verification");
  assert.ok(await f.ports.getVerifiedActivation(f.descriptor));
  assert.deepEqual(
    fs.readFileSync(f.publication.activationFile),
    immutableHead,
  );
  assert.deepEqual(fs.readFileSync(f.trace, "utf8").trim().split("\n"), [
    "query",
    "query",
  ]);
});

for (const fault of [
  "badMac",
  "malformedMac",
  "badLiteral",
  "badBinding",
  "badStore",
])
  test(`readonly native authentication rejects ${fault}`, async (t) => {
    const f = await fixture(t);
    fs.writeFileSync(f.stateFile, JSON.stringify({ [fault]: true }));
    await assert.rejects(core.runtimeRebaselineRoot(f.store, f.reader), {
      code: ["badBinding", "badStore"].includes(fault)
        ? "RUNTIME_BARRIER_CHANGED"
        : "RUNTIME_BARRIER_UNPROVEN",
    });
    assert.equal(await f.ports.getVerifiedActivation(f.descriptor), undefined);
  });

test("changed current pins and another canonical store cannot borrow consumed authority", async (t) => {
  const f = await fixture(t);
  const wrong = core.createRuntimeRebaselineReaderAuthority({
    ...f.ports,
    pins: {
      ...f.options.pins,
      generation: { instance: "other", epoch: "other" },
    },
  });
  await assert.rejects(core.runtimeRebaselineRoot(f.store, wrong), {
    code: "NOT_AUTHORIZED",
  });
  const other = path.join(f.directory, "other");
  fs.mkdirSync(other, { mode: 0o700 });
  const cross = core.createRuntimeRebaselineReaderAuthority({
    ...f.ports,
    store: other,
  });
  await assert.rejects(core.runtimeRebaselineRoot(f.store, cross), {
    code: "NOT_AUTHORIZED",
  });
  assert.equal(fs.readFileSync(f.trace, "utf8"), "");
});

test("local tampering fails before QUERY and completion JSON is not native authority", async (t) => {
  const f = await fixture(t);
  fs.appendFileSync(f.completion.nativeReceipt.reference.path, " ");
  await assert.rejects(core.runtimeRebaselineRoot(f.store, f.reader));
  assert.equal(fs.readFileSync(f.trace, "utf8"), "");
});

test("missing consumed references are refused, never recreated", async (t) => {
  const f = await fixture(t);
  fs.unlinkSync(f.completion.nativeReceipt.reference.path);
  await assert.rejects(core.runtimeRebaselineRoot(f.store, f.reader));
  assert.equal(fs.existsSync(f.completion.nativeReceipt.reference.path), false);
  assert.equal(fs.readFileSync(f.trace, "utf8"), "");
});

test("complete local JSON cannot authorize an absent native consumed row or create one", async (t) => {
  const f = await fixture(t);
  const remove = spawnSync(
    "python3",
    [
      "-c",
      "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('DELETE FROM consumed');c.commit();c.close()",
      f.database,
    ],
    { encoding: "utf8" },
  );
  assert.equal(remove.status, 0, remove.stderr);
  const before = fs.readFileSync(f.database);
  await assert.rejects(core.runtimeRebaselineRoot(f.store, f.reader));
  assert.deepEqual(fs.readFileSync(f.database), before);
  assert.equal(await f.ports.getVerifiedActivation(f.descriptor), undefined);
  assert.equal(fs.readFileSync(f.trace, "utf8"), "query\n");
});

test("post-QUERY POSIX durability failure cannot approve a consumed root", async (t) => {
  const f = await fixture(t);
  const fsync = fs.fsyncSync;
  const sync = t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (fs.readFileSync(f.trace, "utf8").includes("query"))
      throw Object.assign(new Error("owned fsync failure"), { code: "EIO" });
    return fsync(fd);
  });
  await assert.rejects(core.runtimeRebaselineRoot(f.store, f.reader));
  assert.equal(await f.ports.getVerifiedActivation(f.descriptor), undefined);
  sync.mock.restore();
});

test("core final fsync refusal leaves the same native ports without activation approval", async (t) => {
  const f = await fixture(t);
  let nativeVerified = false,
    failed = false;
  const reader = core.createRuntimeRebaselineReaderAuthority({
    ...f.ports,
    async verifyConsumed(publication, completion) {
      const staged = await f.ports.verifyConsumed(publication, completion);
      nativeVerified = true;
      return staged;
    },
  });
  const fsync = fs.fsyncSync;
  const mock = t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (nativeVerified && !failed) {
      failed = true;
      throw Object.assign(new Error("final core fsync"), { code: "EIO" });
    }
    return fsync(fd);
  });
  await assert.rejects(core.runtimeRebaselineRoot(f.store, reader), {
    code: "EIO",
  });
  mock.mock.restore();
  assert.equal(failed, true);
  assert.equal(await f.ports.getVerifiedActivation(f.descriptor), undefined);
});

test("receipt verification alone exposes no activation before core finalization", async (t) => {
  const f = await fixture(t);
  let prematurelyVisible: unknown;
  const reader = core.createRuntimeRebaselineReaderAuthority({
    ...f.ports,
    async verifyConsumed(publication, completion) {
      const staged = await f.ports.verifyConsumed(publication, completion);
      prematurelyVisible = await f.ports.getVerifiedActivation(f.descriptor);
      return staged;
    },
  });
  assert.ok(await core.runtimeRebaselineRoot(f.store, reader));
  assert.equal(prematurelyVisible, undefined);
  assert.ok(await f.ports.getVerifiedActivation(f.descriptor));
});

test("native finalizer fsync refusal never publishes a staged activation", async (t) => {
  const f = await fixture(t);
  let finalizing = false,
    failed = false;
  const reader = core.createRuntimeRebaselineReaderAuthority({
    ...f.ports,
    async verifyConsumed(publication, completion) {
      const staged = await f.ports.verifyConsumed(publication, completion);
      return {
        finalize() {
          finalizing = true;
          staged.finalize();
        },
        abort() {
          staged.abort();
        },
      };
    },
  });
  const fsync = fs.fsyncSync;
  const mock = t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (finalizing && !failed) {
      failed = true;
      throw Object.assign(new Error("finalizer fsync"), { code: "EIO" });
    }
    return fsync(fd);
  });
  await assert.rejects(core.runtimeRebaselineRoot(f.store, reader), {
    code: "EIO",
  });
  mock.mock.restore();
  assert.equal(failed, true);
  assert.equal(await f.ports.getVerifiedActivation(f.descriptor), undefined);
});

test("failed core reapproval invalidates an earlier activation context", async (t) => {
  const f = await fixture(t);
  await core.runtimeRebaselineRoot(f.store, f.reader);
  assert.ok(await f.ports.getVerifiedActivation(f.descriptor));
  let verified = false,
    failed = false;
  const reader = core.createRuntimeRebaselineReaderAuthority({
    ...f.ports,
    async verifyConsumed(publication, completion) {
      const staged = await f.ports.verifyConsumed(publication, completion);
      verified = true;
      return staged;
    },
  });
  const fsync = fs.fsyncSync;
  const mock = t.mock.method(fs, "fsyncSync", (fd: number) => {
    if (verified && !failed) {
      failed = true;
      throw Object.assign(new Error("reapproval fsync"), { code: "EIO" });
    }
    return fsync(fd);
  });
  await assert.rejects(core.runtimeRebaselineRoot(f.store, reader), {
    code: "EIO",
  });
  mock.mock.restore();
  assert.equal(await f.ports.getVerifiedActivation(f.descriptor), undefined);
});

test("malformed UTF-8 cannot collide with signed NEW bytes containing a replacement character", async (t) => {
  const f = await fixture(t, "consumed-reader-\ufffd-");
  const original = Buffer.from(f.publication.activationBytes, "utf8");
  const index = original.indexOf(Buffer.from("\ufffd", "utf8"));
  assert.ok(index >= 0);
  const corrupt = Buffer.concat([
    original.subarray(0, index),
    Buffer.from([0xff]),
    original.subarray(index + 3),
  ]);
  assert.equal(corrupt.toString("utf8"), original.toString("utf8"));
  assert.notDeepEqual(corrupt, original);
  fs.writeFileSync(f.publication.activationFile, corrupt);
  await assert.rejects(core.runtimeRebaselineRoot(f.store, f.reader));
  assert.equal(fs.readFileSync(f.trace, "utf8"), "");
});

if (process.env["FMCAD_READER_IO_CHILD"]) {
  test("owned descriptor race child", async (t) => {
    const f = await fixture(t);
    const kind = process.env["FMCAD_READER_IO_CHILD"];
    const foreign = path.join(f.directory, "foreign-file");
    fs.writeFileSync(foreign, "foreign inode", { mode: 0o600 });
    const foreignDirectory = path.join(f.directory, "foreign-directory");
    fs.mkdirSync(foreignDirectory, { mode: 0o700 });
    let finalPhase = false,
      opens = 0,
      injected = false,
      foreignSynced = false;
    const reader = core.createRuntimeRebaselineReaderAuthority({
      ...f.ports,
      async verifyConsumed(publication, completion) {
        const staged = await f.ports.verifyConsumed(publication, completion);
        finalPhase = true;
        return staged;
      },
    });
    const openSync = fs.openSync;
    const fsync = fs.fsyncSync;
    const syncMock = t.mock.method(fs, "fsyncSync", (fd: number) => {
      const actual = fs.realpathSync(`/proc/self/fd/${fd}`);
      if (actual === foreign || actual === foreignDirectory)
        foreignSynced = true;
      return fsync(fd);
    });
    const mock = t.mock.method(
      fs,
      "openSync",
      (file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        if (
          !injected &&
          kind === "directory" &&
          String(file) === f.store &&
          typeof flags === "number" &&
          flags & fs.constants.O_DIRECTORY &&
          fs.readFileSync(f.trace, "utf8").includes("query")
        ) {
          injected = true;
          return openSync(foreignDirectory, flags, mode);
        }
        if (
          finalPhase &&
          String(file) === f.publication.record.path &&
          ++opens === 4
        ) {
          injected = true;
          if (kind === "foreign-fd") return openSync(foreign, flags, mode);
          if (kind === "fifo") {
            fs.renameSync(
              f.publication.record.path,
              f.publication.record.path + ".saved",
            );
            const fifo = spawnSync(
              "mkfifo",
              ["--mode=600", f.publication.record.path],
              { encoding: "utf8" },
            );
            assert.equal(fifo.status, 0, fifo.stderr);
          }
        }
        return openSync(file, flags, mode);
      },
    );
    await assert.rejects(core.runtimeRebaselineRoot(f.store, reader));
    mock.mock.restore();
    syncMock.mock.restore();
    assert.equal(injected, true);
    assert.equal(foreignSynced, false);
    if (kind === "fifo") {
      fs.unlinkSync(f.publication.record.path);
      fs.renameSync(
        f.publication.record.path + ".saved",
        f.publication.record.path,
      );
    }
    assert.equal(await f.ports.getVerifiedActivation(f.descriptor), undefined);
  });
} else {
  for (const kind of ["fifo", "foreign-fd", "directory"])
    test(`same verified descriptor rejects ${kind} substitution within a bounded child`, (t) => {
      const directory = fs.mkdtempSync("/tmp/opencode/reader-io-child-");
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        FMCAD_READER_IO_CHILD: kind,
        FMCAD_READER_CHILD_BASE: directory,
      };
      delete env["NODE_TEST_CONTEXT"];
      const child = spawnSync(
        process.execPath,
        [
          "--test",
          "--test-reporter=tap",
          "--test-name-pattern=^owned descriptor race child$",
          __filename,
        ],
        {
          env,
          timeout: 10_000,
          encoding: "utf8",
        },
      );
      assert.equal(child.error, undefined, child.stderr);
      assert.equal(child.status, 0, child.stdout + "\n" + child.stderr);
      assert.match(child.stdout, /# tests 1\n/);
      assert.match(child.stdout, /# pass 1\n/);
    });
}

test("a pending concurrent publication refuses a reader without QUERY or issuance", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(
    path.join(f.store, "runtime-rebaseline-publication.json"),
    "{}",
    { mode: 0o600 },
  );
  await assert.rejects(core.runtimeRebaselineRoot(f.store, f.reader), {
    code: "RUNTIME_PUBLICATION_PENDING",
  });
  assert.equal(fs.readFileSync(f.trace, "utf8"), "");
});

async function paused(
  t: TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
  run: () => Promise<unknown>,
  mutate: () => void,
) {
  const ready = path.join(f.directory, "ready"),
    release = path.join(f.directory, "release");
  fs.writeFileSync(
    f.stateFile,
    JSON.stringify({ pause: true, ready, release }),
  );
  const result = run();
  const rejected = assert.rejects(result);
  // A subprocess rendezvous, not a polling loop: fs.watch announces captured response.
  if (!fs.existsSync(ready))
    await new Promise<void>((resolve, reject) => {
      const watcher = fs.watch(f.directory, () => {
        if (fs.existsSync(ready)) {
          watcher.close();
          clearTimeout(timer);
          resolve();
        }
      });
      const timer = setTimeout(() => {
        watcher.close();
        reject(new Error("Native query rendezvous timeout"));
      }, 10000);
      t.after(() => {
        watcher.close();
        clearTimeout(timer);
      });
      if (fs.existsSync(ready)) {
        watcher.close();
        clearTimeout(timer);
        resolve();
      }
    });
  mutate();
  fs.writeFileSync(release, "release");
  await rejected;
}
for (const change of [
  "pointer",
  "snapshot",
  "completion",
  "store",
  "key",
  "package",
  "pending",
])
  test(`post-QUERY ${change} race refuses root approval`, async (t) => {
    const f = await fixture(t);
    await paused(
      t,
      f,
      () => core.runtimeRebaselineRoot(f.store, f.reader),
      () => {
        if (change === "pointer")
          fs.appendFileSync(f.publication.activationFile, " ");
        if (change === "snapshot")
          fs.appendFileSync(path.join(f.store, "queue-state.json"), " ");
        if (change === "completion")
          fs.appendFileSync(
            path.join(
              f.store,
              "runtime-rebaselines",
              f.request.requestId,
              "completion.json",
            ),
            " ",
          );
        if (change === "store") {
          fs.renameSync(f.store, f.store + "-retired");
          fs.mkdirSync(f.store, { mode: 0o700 });
        }
        if (change === "key")
          fs.appendFileSync(
            f.options.publicationAuthority.keyReference.path,
            " ",
          );
        if (change === "package")
          fs.writeFileSync(
            path.join(
              f.options.native.mappedInstalledForkDirectory,
              "unexpected.py",
            ),
            "# unexpected package member",
          );
        if (change === "pending")
          fs.writeFileSync(
            path.join(f.store, "runtime-rebaseline-publication.json"),
            "{}",
            { mode: 0o600 },
          );
      },
    );
    assert.equal(await f.ports.getVerifiedActivation(f.descriptor), undefined);
  });

test("getVerifiedActivation re-queries then rechecks NEW bytes before returning a tuple", async (t) => {
  const f = await fixture(t);
  await core.runtimeRebaselineRoot(f.store, f.reader);
  await paused(
    t,
    f,
    () => f.ports.getVerifiedActivation(f.descriptor),
    () => {
      fs.appendFileSync(f.publication.activationFile, " ");
    },
  );
});
