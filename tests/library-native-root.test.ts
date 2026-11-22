import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { createNativeRuntimeRebaselineAuthorityPorts } from "../packages/node-adapters/src/execution/runtime-rebaseline-native";
import type { FmcadConfiguration } from "../src/api/contracts";

const load = createRequire(path.join(process.cwd(), "src/queue-broker.js"));
const core = load(
  "./queue-runtime-rebaseline",
) as typeof import("../src/queue-runtime-rebaseline");
const { createFmcad } = load("./dist/api") as typeof import("../src/api");
const { resolveFmcadConfiguration } = load(
  "./dist/core",
) as typeof import("../packages/core/src");
const { buildHash, brokerConfigHash } = load("./queue-instance") as {
  buildHash(): string;
  brokerConfigHash(config: FmcadConfiguration): string;
};
const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** Real publication, consumed MAC, profile, private realm and public library.
 * Only the external native executable and broker IPC are offline fixtures. */
async function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync("/tmp/opencode/library-native-root-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (file: string, value: unknown) => {
    const bytes = Buffer.from(
      typeof value === "string" ? value : JSON.stringify(value),
    );
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return { path: file, sha256: sha(bytes) };
  };
  const store = path.join(directory, "fmcad", "queue");
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  const config: FmcadConfiguration = resolveFmcadConfiguration({
    adapter: {
      backend: "addin",
      url: "http://127.0.0.1:8765/mcp",
      timeoutMs: 100,
    },
    environment: {},
    file: {},
    platformDefaults: {},
    acceptedService: null,
  });
  const currentBuild = buildHash(),
    configHash = brokerConfigHash(config);
  const epoch = path.join(store, "admission-epochs", "retired");
  fs.mkdirSync(epoch, { recursive: true, mode: 0o700 });
  write(path.join(store, "isolated-admission-epoch.json"), {
    epochId: "retired",
    root: epoch,
  });
  const snapshot = {
    version: 1,
    jobs: {
      "old-root": {
        id: "old-root",
        requestId: "old-root-request",
        clientId: "old-owner",
        state: "needs_reconciliation",
        request: { kind: "run" },
      },
    },
    quarantined: { "old-root": { target: null } },
  };
  write(path.join(store, "queue-state.json"), snapshot);
  write(path.join(store, "instance.json"), {
    buildHash: "old",
    configHash: "old",
  });
  write(path.join(epoch, "queue-state.json"), {
    ...snapshot,
    jobs: {
      "old-epoch": {
        ...snapshot.jobs["old-root"],
        id: "old-epoch",
        requestId: "old-epoch-request",
      },
    },
    quarantined: { "old-epoch": { target: null } },
  });
  write(path.join(epoch, "instance.json"), {
    buildHash: "retired",
    configHash: "retired",
  });
  // Intentionally not a valid legacy lineage; native consumed evidence is the
  // authority for these frozen bytes, not legacy admission or a public flag.
  write(path.join(store, "physical-backend-head.json"), {
    history: "unproven",
  });
  const { initializeRuntimeVerificationRealm } = load(
    "./dist/node-adapters/execution/runtime-verification-realm",
  ) as typeof import("../packages/node-adapters/src/execution/runtime-verification-realm");
  const realm = initializeRuntimeVerificationRealm(store);
  const fork = path.join(directory, "fork");
  fs.mkdirSync(path.join(fork, "lib"), { recursive: true, mode: 0o700 });
  const files: Record<string, string> = {};
  for (const name of [
    "physical_authority.py",
    "physical_lifecycle.py",
    "request_admission.py",
    "rebaseline_fence.py",
  ]) {
    const raw = "# owned offline native executable fixture\n";
    write(path.join(fork, "lib", name), raw);
    files[`lib/${name}`] = sha(raw);
  }
  const trace = path.join(directory, "actions.txt"),
    nativeState = path.join(directory, "native.json");
  const fault = path.join(directory, "fault.json");
  const executable = path.join(directory, "python.exe");
  write(
    executable,
    `#!${process.execPath}
const fs=require('node:fs'),crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{
const e=JSON.parse(raw),q=JSON.parse(e.requestJson);
fs.appendFileSync(${JSON.stringify(trace)},e.action+'\\n');
if(!['begin','query','consume'].includes(e.action))process.exit(90);
const key=fs.readFileSync(${JSON.stringify(realm.keyReference.path)});
const file=${JSON.stringify(nativeState)};
let s=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
if(e.action==='begin'){
 s={kind:'fmcad-provision-fence',version:1,state:'pending',binding:{
 requestId:q.requestId,fenceNonce:'fixture-nonce',handoffId:q.handoffId,generation:e.descriptor.generation,
 physicalRuntime:e.descriptor.physicalRuntime,endpointURL:'http://127.0.0.1:8765/mcp',store:q.store,
 oldHead:q.expectedHead,intentReferences:q.intentReferences,initiatorOperatorId:'operator-one',writerGeneration:q.writerGeneration}};
 fs.writeFileSync(file,JSON.stringify(s),{mode:0o600});
}
if(!s){process.stdout.write(JSON.stringify({kind:'fmcad-provision-fence',version:1,state:'absent',requestId:q.requestId}));return;}
if(e.action==='consume'){
 const p=JSON.parse(q.publicationJson),a=JSON.parse(p.activationBytes),digest=sha(q.publicationJson);
 function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v;}
 const mac=crypto.createHmac('sha256',key).update('fmcad-posix-publication-v1\\0').update(JSON.stringify(sort({binding:s.binding,publicationDigest:digest}))).digest('hex');
 if(q.attestation.mac!==mac)process.exit(91);
 const receipt={kind:'fmcad-rebaseline-consumed',version:1,fence:s.binding,activation:{
 requestId:s.binding.requestId,fenceNonce:s.binding.fenceNonce,newHead:a.newHead,publicationDigest:digest,
 record:p.record,initiatorOperatorId:s.binding.initiatorOperatorId},consumedBy:'operator-one'};
 const receiptJson=JSON.stringify(receipt);
 s={...s,state:'consumed',publicationJson:q.publicationJson,receiptJson,receiptDigest:sha(receiptJson),
 receiptMac:crypto.createHmac('sha256',key).update('fmcad-native-consume-v1\\0').update(receiptJson).digest('hex')};
 fs.writeFileSync(file,JSON.stringify(s),{mode:0o600});
}
const fault=fs.existsSync(${JSON.stringify(fault)})?JSON.parse(fs.readFileSync(${JSON.stringify(fault)})):{};
if(e.action==='query'&&fault.corruptReceipt)s.receiptMac='0'.repeat(64);
if(e.action==='query'&&fault.mutateCurrent)fs.appendFileSync(${JSON.stringify(path.join(store, "queue-state.json"))},' ');
process.stdout.write(JSON.stringify(s));
});`,
  );
  fs.chmodSync(executable, 0o700);
  const pins = {
    handoffId: "handoff",
    admissionStore: "C:\\private\\fmcad\\addin-admission\\admission.sqlite3",
    generation: { instance: "instance", epoch: "epoch" },
    process: { pid: 22, birth: "new-birth" },
    source: "source",
    build: "build",
    endpoint: "http://127.0.0.1:8765/mcp",
  };
  const native = {
    nativePython: "C:\\Python\\python.exe",
    mappedNativePython: executable,
    nativePythonSha256: sha(fs.readFileSync(executable)),
    installedForkDirectory: "C:\\fork",
    mappedInstalledForkDirectory: fork,
    installedPackageFiles: files,
    provisionPath: "C:\\private\\provision.json",
    localAppData: "C:\\private",
    nativePrivateDirectory: "C:\\private",
    mappedPrivateDirectory: directory,
    linuxGrantDirectory: directory,
  };
  const evidence = (name: string, value: unknown) =>
    write(path.join(directory, name), value);
  const committed = {
    state: "committed",
    handoffId: "handoff",
    nextGeneration: pins.generation,
  };
  const ports = createNativeRuntimeRebaselineAuthorityPorts({
    store,
    pins,
    native,
    runtimeVersion: "test",
    operatorId: "operator-one",
    evidenceDirectory: directory,
    publicationAuthority: {
      ...realm,
      nativeOperatorFile: "C:\\private\\runtime-rebaseline-operator.json",
    },
    originalEvidence: {
      retiredProcess: evidence("retired.json", {
        exited: true,
        oldPidPresent: false,
        forceUsed: false,
        oldPid: 11,
        oldBirth: "old-birth",
      }),
      coldProcess: evidence("cold.json", {
        ...pins.process,
        exe: "C:\\Fusion.exe",
      }),
      committedHandoff: evidence("committed.json", committed),
      completedHandoff: evidence("completed.json", {
        ...committed,
        state: "completed",
      }),
      preservedRows: evidence("rows.json", {
        databasePath: pins.admissionStore,
        sameDatabase: true,
        allOldAdmissionRowsPreserved: true,
        allOldHistoryRowsPreserved: true,
        exactlyOneCommittedHandoffRow: true,
        handoffReceipt: committed,
        grantIssued: false,
        sdkProgramSubmitted: false,
      }),
      sourceArchive: evidence("archive.bin", "original archive"),
    },
    writer: {
      async withExclusiveWriter(work) {
        const lock = path.join(directory, "writer.lock"),
          fd = fs.openSync(lock, "wx", 0o600);
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
  });
  await core.rebaselineRuntime(
    store,
    {
      requestId: "request",
      handoffId: pins.handoffId,
      expectedHead: core.literalRuntimeHead(store).digest,
    },
    core.createRuntimeRebaselineAuthority(ports),
  );
  write(path.join(store, "runtime-rebaseline-current-instance.json"), {
    buildHash: currentBuild,
    configHash,
  });
  write(path.join(store, "broker.lock"), { protocol: 2 });
  const profile = evidence("profile.json", {
    version: 1,
    clientId: "broker-client",
    transport: "node",
    nativeProvision: native,
    runtime: {
      kind: "fmcad-physical-grant",
      version: 1,
      handoffId: pins.handoffId,
      generation: pins.generation,
      endpointURL: pins.endpoint,
      physicalRuntime: {
        ...pins.process,
        version: "test",
        source: pins.source,
        build: pins.build,
      },
    },
  }).path;
  const oldHome = process.env["XDG_STATE_HOME"],
    oldProfile = process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"];
  process.env["XDG_STATE_HOME"] = directory;
  process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"] = profile;
  t.after(() => {
    if (oldHome === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = oldHome;
    if (oldProfile === undefined)
      delete process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"];
    else process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"] = oldProfile;
  });
  const calls: string[] = [];
  const clientFile = load.resolve("./queue-client");
  load(clientFile);
  const original = load.cache[clientFile]!.exports;
  load.cache[clientFile]!.exports = {
    QueueClient: class {
      async register() {
        calls.push("register");
      }
      async call(action: string) {
        calls.push(action);
        if (action === "control-status")
          return { buildHash: currentBuild, activeOperations: 0 };
        if (action === "queue-summary")
          return {
            buildHash: currentBuild,
            admissionScope: "native-approved-runtime-root",
          };
        assert.fail(`unexpected IPC ${action}`);
      }
      dispose() {}
    },
  };
  t.after(() => {
    load.cache[clientFile]!.exports = original;
  });
  const service = () => {
    const api = createFmcad({
      version: 1,
      config,
      context: {
        clientId: "library-owner",
        projectDirectory: directory,
        instanceId: "library-instance",
        source: "mcp",
      },
    });
    t.after(() => api.dispose());
    return api;
  };
  return {
    store,
    epoch,
    profile,
    configHash,
    currentBuild,
    calls,
    fault,
    write,
    service,
    trace,
  };
}

test("public library starts and reads status through authentic consumed root without legacy restore or writes", async (t) => {
  const f = await fixture(t);
  const before = core.literalRuntimeHead(f.store);
  const actions = fs.readFileSync(f.trace, "utf8");
  const api = f.service();
  await api.start();
  assert.deepEqual(await api.query.status(), {
    version: 1,
    build: f.currentBuild,
    blocked: false,
    active: false,
  });
  assert.deepEqual(f.calls, ["register", "control-status", "control-status"]);
  assert.deepEqual(core.literalRuntimeHead(f.store), before);
  assert.ok(
    fs
      .readFileSync(f.trace, "utf8")
      .slice(actions.length)
      .trim()
      .split("\n")
      .every((action) => action === "query"),
  );
});

for (const failure of [
  "missing-profile",
  "forged-receipt",
  "changed-frozen",
  "changed-during-query",
  "wrong-build",
  "wrong-config",
  "wrong-state-version",
] as const) {
  test(`public consumed-root fence rejects ${failure} before registration`, async (t) => {
    const f = await fixture(t);
    if (failure === "missing-profile")
      delete process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"];
    if (failure === "forged-receipt")
      f.write(f.fault, { corruptReceipt: true });
    if (failure === "changed-frozen")
      fs.appendFileSync(
        path.join(
          f.store,
          "runtime-rebaselines",
          "request",
          "admission-epochs",
          "retired",
          "queue-state.json",
        ),
        " ",
      );
    if (failure === "changed-during-query")
      f.write(f.fault, { mutateCurrent: true });
    if (failure === "wrong-build" || failure === "wrong-config")
      f.write(path.join(f.store, "runtime-rebaseline-current-instance.json"), {
        buildHash: failure === "wrong-build" ? "0".repeat(64) : f.currentBuild,
        configHash: failure === "wrong-config" ? "0".repeat(64) : f.configHash,
      });
    if (failure === "wrong-state-version")
      f.write(path.join(f.store, "queue-state.json"), {
        version: 99,
        jobs: {},
      });
    await assert.rejects(
      f.service().start(),
      (error: NodeJS.ErrnoException & { boundary?: string }) => {
        if (failure === "missing-profile")
          assert.equal(error.code, "RUNTIME_ROOT_AUTHORITY_REQUIRED");
        else if (
          ["wrong-build", "wrong-config", "wrong-state-version"].includes(
            failure,
          )
        ) {
          assert.equal(error.code, "FMCAD_INCOMPATIBLE_CONTRACT");
          assert.equal(
            error.boundary,
            failure === "wrong-build"
              ? "build"
              : failure === "wrong-config"
                ? "configuration"
                : "persistedState",
          );
        } else
          assert.equal(
            error.code,
            failure === "forged-receipt"
              ? "RUNTIME_BARRIER_UNPROVEN"
              : "RUNTIME_BARRIER_CHANGED",
          );
        return true;
      },
    );
    assert.deepEqual(f.calls, []);
  });
}

test("public native-root status accepts a new committed current snapshot instead of requiring the old frozen root", async (t) => {
  const f = await fixture(t),
    api = f.service();
  await api.start();
  const file = path.join(f.store, "queue-state.json");
  f.write(file, { ...JSON.parse(fs.readFileSync(file, "utf8")), revision: 2 });
  assert.equal((await api.query.status()).build, f.currentBuild);
  assert.deepEqual(f.calls, ["register", "control-status", "control-status"]);
});

test("public native-root fence waits for a non-UUID epoch pending snapshot without restoring it", async (t) => {
  const f = await fixture(t),
    api = f.service();
  const pending = path.join(f.epoch, "queue-state.pending.json");
  f.write(pending, { version: 1 });
  const before = fs.readFileSync(f.trace, "utf8");
  const settled = new Promise<void>((resolve) => {
    setTimeout(() => {
      assert.deepEqual(f.calls, []);
      assert.equal(fs.readFileSync(f.trace, "utf8"), before);
      fs.unlinkSync(pending);
      resolve();
    }, 30);
  });
  await api.start();
  await settled;
  assert.deepEqual(f.calls, ["register", "control-status"]);
});
