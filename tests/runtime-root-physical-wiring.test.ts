import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { physicalBrokerPortsFromEnvironment } from "../packages/node-adapters/src/execution/physical-generation-profile";
import {
  createNativeRuntimeRebaselineAuthorityPorts,
  type NativeRuntimeRebaselineOptions,
} from "../packages/node-adapters/src/execution/runtime-rebaseline-native";
import { claimBrokerLifetime } from "../packages/node-adapters/src/execution/broker-lifetime";

const load = createRequire(path.join(process.cwd(), "src/queue-broker.js"));
const core = load(
  "./queue-runtime-rebaseline",
) as typeof import("../src/queue-runtime-rebaseline");
const wiring = load(
  "./queue-runtime-physical-wiring",
) as typeof import("../src/queue-runtime-physical-wiring");
const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** Real core, adapter, profile, owner claim and private provisioner. Only the
 * external Windows CLI is replaced by a persistent, owned executable fixture. */
function fixture(t: { after(action: () => void): void }) {
  const directory = fs.mkdtempSync("/tmp/opencode/root-physical-wiring-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name: string, value: unknown) => {
    const bytes = Buffer.from(
      typeof value === "string" ? value : JSON.stringify(value),
    );
    const file = path.join(directory, name);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return { path: file, sha256: sha(bytes) };
  };
  const store = path.join(directory, "store"),
    mailbox = path.join(directory, "mailbox");
  fs.mkdirSync(store, { mode: 0o700 });
  fs.mkdirSync(mailbox, { mode: 0o700 });
  const snapshot = {
    version: 1,
    jobs: {
      old: {
        id: "old",
        state: "needs_reconciliation",
        request: { kind: "run" },
      },
    },
    quarantined: { old: { target: null } },
  };
  fs.writeFileSync(
    path.join(store, "queue-state.json"),
    JSON.stringify(snapshot),
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(store, "physical-backend-head.json"),
    '{"history":"unproven"}',
    { mode: 0o600 },
  );
  fs.mkdirSync(path.join(directory, "lib"), { mode: 0o700 });
  const files: Record<string, string> = {};
  for (const name of [
    "physical_authority.py",
    "physical_lifecycle.py",
    "request_admission.py",
    "rebaseline_fence.py",
  ]) {
    const raw = "# owned offline source\n";
    fs.writeFileSync(path.join(directory, "lib", name), raw, { mode: 0o600 });
    files[`lib/${name}`] = sha(raw);
  }
  const executable = path.join(directory, "python.exe"),
    state = path.join(directory, "native-state.json");
  const fault = path.join(directory, "fault.json"),
    trace = path.join(directory, "actions.txt");
  fs.writeFileSync(
    executable,
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
let raw='';process.stdin.on('data',b=>raw+=b);process.stdin.on('end',()=>{
const e=JSON.parse(raw),action=e.action;
fs.appendFileSync(${JSON.stringify(trace)},action+'\\n');
const fault=fs.existsSync(${JSON.stringify(fault)})?JSON.parse(fs.readFileSync(${JSON.stringify(fault)})):{};
const file=${JSON.stringify(state)};
let current=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
const mapped=name=>path.join(${JSON.stringify(mailbox)},...name.replace(/^C:\\\\private\\\\?/,'').split('\\\\'));
if(action==='prepare'){
 const dir=path.join(${JSON.stringify(mailbox)},e.attempt);fs.mkdirSync(dir,{mode:0o700});
 fs.writeFileSync(path.join(dir,'request.json'),e.descriptorRaw,{mode:0o600});
 if(e.activationRaw===undefined)process.exit(82);
 fs.writeFileSync(path.join(dir,'activation.json'),e.activationRaw,{mode:0o600});
 if(fault.loseOwnerAfterPrepare)fs.writeFileSync(${JSON.stringify(path.join(store, "broker.lock"))},'{"changed":true}');
 process.stdout.write(sha(e.descriptorRaw));return;
}
if(action==='grant'){
 if(!current||current.state!=='consumed')process.exit(83);
 const approved=JSON.parse(current.receiptJson).activation,a=JSON.parse(e.activationRaw);
 const expected={requestId:approved.requestId,fenceNonce:approved.fenceNonce,newHead:approved.newHead,
 publicationDigest:approved.publicationDigest,receiptDigest:current.receiptDigest};
 if(JSON.stringify(a)!==JSON.stringify(expected))process.exit(84);
 const request=JSON.parse(fs.readFileSync(mapped(e.request),'utf8'));
 fs.writeFileSync(mapped(e.output),JSON.stringify({...request,token:'offline-only-private-token-'.repeat(4)}),{mode:0o600});
 process.stdout.write(JSON.stringify({state:'granted',handoffId:request.handoffId}));return;
}
if(action==='verify'){
 if(fault.loseOwnerDuringVerify)fs.writeFileSync(${JSON.stringify(path.join(store, "broker.lock"))},'{"changed":true}');
 process.stdout.write(sha(fs.readFileSync(mapped(e.output))));return;
}
const q=JSON.parse(e.requestJson);
if(fault.badReceipt&&current?.state==='consumed')current.receiptMac='0'.repeat(64);
if(action==='begin'){
 if(!current)current={kind:'fmcad-provision-fence',version:1,state:'pending',binding:{
 requestId:q.requestId,fenceNonce:'fixture-nonce',handoffId:q.handoffId,generation:e.descriptor.generation,
 physicalRuntime:e.descriptor.physicalRuntime,endpointURL:'http://127.0.0.1:8765/mcp',store:q.store,oldHead:q.expectedHead,
 intentReferences:q.intentReferences,initiatorOperatorId:'operator-one',writerGeneration:q.writerGeneration}};
 fs.writeFileSync(file,JSON.stringify(current),{mode:0o600});
}
if(!current){process.stdout.write(JSON.stringify({kind:'fmcad-provision-fence',version:1,state:'absent',requestId:q.requestId}));return;}
if(action==='consume'){
 const p=JSON.parse(q.publicationJson),a=JSON.parse(p.activationBytes),digest=sha(q.publicationJson);
 function sort(v){if(Array.isArray(v))return v.map(sort);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])]));return v;}
 const mac=crypto.createHmac('sha256',Buffer.alloc(32,7)).update('fmcad-posix-publication-v1\\0')
 .update(JSON.stringify(sort({binding:current.binding,publicationDigest:digest}))).digest('hex');
 if(q.attestation.mac!==mac)process.exit(85);
 const receipt={kind:'fmcad-rebaseline-consumed',version:1,fence:current.binding,activation:{
 requestId:current.binding.requestId,fenceNonce:current.binding.fenceNonce,newHead:a.newHead,publicationDigest:digest,
 record:p.record,initiatorOperatorId:current.binding.initiatorOperatorId},consumedBy:'operator-one'};
 const receiptJson=JSON.stringify(receipt);
 current={...current,state:'consumed',publicationJson:q.publicationJson,receiptJson,receiptDigest:sha(receiptJson),
 receiptMac:crypto.createHmac('sha256',Buffer.alloc(32,7)).update('fmcad-native-consume-v1\\0').update(receiptJson).digest('hex')};
 fs.writeFileSync(file,JSON.stringify(current),{mode:0o600});
}
process.stdout.write(JSON.stringify(current));
});`,
    { mode: 0o700 },
  );
  const committed = {
    state: "committed",
    handoffId: "handoff",
    nextGeneration: { instance: "instance", epoch: "epoch" },
  };
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
      endpoint: "http://127.0.0.1:8765/mcp",
    },
    evidenceDirectory: directory,
    originalEvidence: {
      retiredProcess: write("retired.json", {
        exited: true,
        oldPidPresent: false,
        forceUsed: false,
        oldPid: 11,
        oldBirth: "old-birth",
      }),
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
      mappedPrivateDirectory: mailbox,
      linuxGrantDirectory: directory,
    },
    publicationAuthority: {
      keyId: "fixture-key",
      keyReference: (() => {
        const file = path.join(directory, "key"),
          bytes = Buffer.alloc(32, 7);
        fs.writeFileSync(file, bytes, { mode: 0o600 });
        return { path: file, sha256: sha(bytes) };
      })(),
      nativeOperatorFile: "C:\\private\\operator.json",
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
  };
  const runtime = {
    kind: "fmcad-physical-grant" as const,
    version: 1 as const,
    handoffId: "handoff",
    generation: options.pins.generation,
    endpointURL: options.pins.endpoint,
    physicalRuntime: {
      ...options.pins.process,
      version: options.runtimeVersion,
      source: options.pins.source,
      build: options.pins.build,
    },
  };
  const profile = write("profile.json", {
    version: 1,
    clientId: "broker-client",
    transport: "node",
    runtime,
    nativeProvision: options.native,
  }).path;
  let factoryCalls = 0;
  function physical() {
    const ports = physicalBrokerPortsFromEnvironment(
      { FMCAD_PHYSICAL_OPERATOR_PROFILE: profile },
      {
        runtimeRootFactory: wiring.createRuntimeRootPhysicalProfileFactory(
          (verified) => {
            factoryCalls++;
            assert.ok(Object.isFrozen(verified));
            assert.ok(
              Object.isFrozen(verified.nativeProvision.installedPackageFiles),
            );
            return { ...options, native: verified.nativeProvision };
          },
        ),
      },
    );
    assert.ok(ports);
    return ports;
  }
  const context = {
    directory: store,
    buildHash: "b".repeat(64),
    configHash: "c".repeat(64),
  };
  function claim() {
    const lifetime = claimBrokerLifetime({
      dir: store,
      socket: path.join(store, "broker.sock"),
      buildHash: context.buildHash,
      configHash: context.configHash,
      processBirth: () => "owned-process-birth",
      disposeClient() {},
    });
    t.after(() => {
      // The owner-loss case changes only our fixture's marker bytes.
      if (fs.existsSync(lifetime.lock)) {
        fs.writeFileSync(lifetime.lock, JSON.stringify(lifetime.owner));
        lifetime.abortBeforeInitialize();
      }
    });
    return {
      ...context,
      owner: lifetime.owner,
      assertBrokerOwner: lifetime.assertOwner,
    };
  }
  return {
    directory,
    store,
    options,
    profile,
    fault,
    trace,
    physical,
    claim,
    context,
    runtime,
    factoryCalls: () => factoryCalls,
    actions: () =>
      fs.existsSync(trace)
        ? fs.readFileSync(trace, "utf8").trim().split("\n")
        : [],
    async bootstrap() {
      const ports = createNativeRuntimeRebaselineAuthorityPorts(options);
      const authority = core.createRuntimeRebaselineAuthority(ports);
      await core.rebaselineRuntime(
        store,
        {
          requestId: "request",
          handoffId: "handoff",
          expectedHead: core.literalRuntimeHead(store).digest,
        },
        authority,
      );
    },
  };
}

test("one verified profile read connects actual core/native approval to the ordinary claimed private grant", async (t) => {
  const f = fixture(t);
  await f.bootstrap();
  const physical = f.physical();
  assert.equal(f.factoryCalls(), 1);
  const approved = await physical.verifyRuntimeRootBeforeRestore(f.context);
  assert.ok(approved);
  assert.equal(approved.record.history, "preserved_unproven");
  assert.equal(approved.record.dispositions["old"]?.outcome, "unknown");
  assert.equal(f.actions().filter((action) => action === "grant").length, 0);
  // This cannot trigger another profile read or change the closed pinned input.
  fs.writeFileSync(f.profile, '{"untrusted":"replacement"}', { mode: 0o600 });
  const before = f.actions().length;
  await physical.preparePhysicalGeneration(f.claim());
  assert.ok(
    f.actions().slice(before).includes("query"),
    "fresh authenticated native QUERY is required",
  );
  assert.equal(f.actions().filter((action) => action === "grant").length, 1);
  assert.equal(f.factoryCalls(), 1);
  assert.equal(
    physical.authorizePhysicalRequest(f.runtime.endpointURL)[
      "X-Fmcad-Physical-Grant"
    ],
    "offline-only-private-token-".repeat(4),
  );
});

test("an existing completion does not authorize a profile before async root verification", async (t) => {
  const f = fixture(t);
  await f.bootstrap();
  const physical = f.physical();
  await assert.rejects(physical.preparePhysicalGeneration(f.claim()), {
    code: "RUNTIME_ROOT_AUTHORITY_REQUIRED",
  });
  assert.equal(f.actions().filter((action) => action === "grant").length, 0);
});

test("an approved head without the private operator controller fails closed before restore or issuance", async (t) => {
  const f = fixture(t);
  await f.bootstrap();
  const physical = physicalBrokerPortsFromEnvironment({
    FMCAD_PHYSICAL_OPERATOR_PROFILE: f.profile,
  });
  assert.ok(physical);
  await assert.rejects(physical.verifyRuntimeRootBeforeRestore(f.context), {
    code: "RUNTIME_ROOT_CONTROLLER_REQUIRED",
  });
  await assert.rejects(physical.preparePhysicalGeneration(f.claim()), {
    code: "RUNTIME_ROOT_CONTROLLER_REQUIRED",
  });
  assert.equal(f.actions().filter((action) => action === "grant").length, 0);
});

test("a missing approved root never becomes a fresh-store grant path", async (t) => {
  const f = fixture(t),
    physical = f.physical();
  await assert.rejects(physical.verifyRuntimeRootBeforeRestore(f.context), {
    code: "RUNTIME_ROOT_AUTHORITY_REQUIRED",
  });
  await assert.rejects(physical.preparePhysicalGeneration(f.claim()), {
    code: "RUNTIME_ROOT_AUTHORITY_REQUIRED",
  });
  assert.equal(f.actions().filter((action) => action === "grant").length, 0);
  assert.equal(
    fs.readFileSync(path.join(f.store, "physical-backend-head.json"), "utf8"),
    '{"history":"unproven"}',
  );
});

for (const changed of ["head", "native-receipt", "owner"] as const)
  test(`changed ${changed} refuses before private grant issuance`, async (t) => {
    const f = fixture(t);
    await f.bootstrap();
    const physical = f.physical();
    await physical.verifyRuntimeRootBeforeRestore(f.context);
    const claim = f.claim();
    if (changed === "head")
      fs.appendFileSync(
        path.join(f.store, "runtime-rebaseline-head.json"),
        " ",
      );
    if (changed === "native-receipt")
      fs.writeFileSync(f.fault, JSON.stringify({ badReceipt: true }));
    if (changed === "owner")
      fs.writeFileSync(path.join(f.store, "broker.lock"), '{"changed":true}');
    await assert.rejects(physical.preparePhysicalGeneration(claim));
    assert.equal(f.actions().filter((action) => action === "grant").length, 0);
  });

test("owner loss during asynchronous native preparation is checked before the grant subprocess", async (t) => {
  const f = fixture(t);
  await f.bootstrap();
  const physical = f.physical();
  await physical.verifyRuntimeRootBeforeRestore(f.context);
  fs.writeFileSync(f.fault, JSON.stringify({ loseOwnerAfterPrepare: true }));
  await assert.rejects(physical.preparePhysicalGeneration(f.claim()));
  assert.equal(f.actions().filter((action) => action === "prepare").length, 1);
  assert.equal(f.actions().filter((action) => action === "grant").length, 0);
});

test("owner loss after issuance during native verify remains UNKNOWN and never publishes authorization", async (t) => {
  const f = fixture(t);
  await f.bootstrap();
  const physical = f.physical();
  await physical.verifyRuntimeRootBeforeRestore(f.context);
  fs.writeFileSync(f.fault, JSON.stringify({ loseOwnerDuringVerify: true }));
  await assert.rejects(physical.preparePhysicalGeneration(f.claim()), {
    code: "PHYSICAL_GENERATION_REJECTED",
    grantIssuance: "unknown",
  });
  assert.equal(f.actions().filter((action) => action === "grant").length, 1);
  assert.equal(f.actions().filter((action) => action === "verify").length, 1);
  assert.throws(() => physical.authorizePhysicalRequest(f.runtime.endpointURL));
  const privateDirectory = f.options.native.mappedPrivateDirectory;
  assert.equal(
    fs
      .readdirSync(privateDirectory)
      .filter((name) =>
        fs.existsSync(path.join(privateDirectory, name, "grant.json")),
      ).length,
    1,
  );
});

test("profile JSON cannot add a runtime activation or manufacture an operator controller", async (t) => {
  for (const nested of [false, true]) {
    const f = fixture(t);
    const profile = JSON.parse(fs.readFileSync(f.profile, "utf8"));
    if (nested)
      profile.nativeProvision.getVerifiedActivation = { requestId: "forged" };
    else profile.runtimeRootFactory = { approved: true };
    fs.writeFileSync(f.profile, JSON.stringify(profile));
    assert.throws(() => f.physical(), {
      code: "PHYSICAL_OPERATOR_PROFILE_REJECTED",
    });
    assert.equal(f.factoryCalls(), 0);
    assert.deepEqual(f.actions(), []);
  }
});

test("the trusted options factory cannot silently substitute the one-read native profile pins", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      physicalBrokerPortsFromEnvironment(
        {
          FMCAD_PHYSICAL_OPERATOR_PROFILE: f.profile,
        },
        {
          runtimeRootFactory: wiring.createRuntimeRootPhysicalProfileFactory(
            (profile) => ({
              ...f.options,
              native: {
                ...profile.nativeProvision,
                nativePrivateDirectory: "C:\\other",
              },
            }),
          ),
        },
      ),
    { code: "PHYSICAL_OPERATOR_PROFILE_REJECTED" },
  );
  assert.deepEqual(f.actions(), []);
});
