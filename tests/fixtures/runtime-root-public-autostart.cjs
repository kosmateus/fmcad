"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

module.exports = async function seedNativeRuntimeRoot({
  repo,
  base,
  store,
  config,
  endpoint,
  clientId,
}) {
  const load = createRequire(path.join(repo, "src/queue-broker.js"));
  const qi = load("./queue-instance");
  const core = load("./queue-runtime-rebaseline");
  const configApi = load("./config");
  const { initializeRuntimeVerificationRealm } = load(
    "./dist/node-adapters/execution/runtime-verification-realm",
  );
  const { createNativeRuntimeRebaselineAuthorityPorts } = require(
    path.join(
      repo,
      "packages/node-adapters/dist/execution/runtime-rebaseline-native.js",
    ),
  );

  const identity = {
    pid: process.pid,
    birth: qi.processBirth(process.pid),
    version: "offline-native-root-fixture",
  };
  const environmentKeys = new Set([
    ...Object.keys(process.env).filter((name) => name.startsWith("FMCAD_")),
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ]);
  const previousEnvironment = new Map(
    [...environmentKeys].map((name) => [name, process.env[name]]),
  );
  for (const name of environmentKeys) delete process.env[name];
  process.env["FMCAD_BACKEND"] = "addin";
  process.env["FMCAD_CONFIG"] = config;
  process.env["XDG_STATE_HOME"] = path.join(base, "state");
  process.env["XDG_DATA_HOME"] = path.join(base, "data");
  process.env["XDG_CACHE_HOME"] = path.join(base, "cache");
  let cfg;
  try {
    cfg = configApi.loadConfig({ config, backend: "addin" }).cfg;
  } finally {
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  const buildHash = qi.buildHash();
  const configHash = qi.brokerConfigHash(cfg);
  const epoch = path.join(store, "admission-epochs", "retired");
  fs.mkdirSync(epoch, { recursive: true, mode: 0o700 });
  const write = (file, value) => {
    const bytes = Buffer.from(
      typeof value === "string" ? value : JSON.stringify(value),
    );
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return { path: file, sha256: sha(bytes) };
  };
  write(path.join(store, "isolated-admission-epoch.json"), {
    epochId: "retired",
    root: epoch,
  });
  const snapshot = {
    version: 1,
    paused: false,
    revision: 0,
    epoch: 0,
    blocked: null,
    active: null,
    lease: null,
    jobs: {},
    lastClient: null,
    quarantined: {},
  };
  write(path.join(store, "queue-state.json"), snapshot);
  write(path.join(store, "instance.json"), {
    buildHash: "retired-build",
    configHash: "retired-config",
  });
  write(path.join(epoch, "queue-state.json"), snapshot);
  write(path.join(epoch, "instance.json"), {
    buildHash: "retired-build",
    configHash: "retired-config",
  });
  write(path.join(store, "physical-backend-head.json"), {
    history: "unproven",
  });
  const realm = initializeRuntimeVerificationRealm(store);

  const privateDirectory = path.join(base, "private");
  const grantsDirectory = path.join(base, "grants");
  const fork = path.join(base, "fork");
  fs.mkdirSync(privateDirectory, { mode: 0o700 });
  fs.mkdirSync(grantsDirectory, { mode: 0o700 });
  fs.mkdirSync(path.join(fork, "lib"), { recursive: true, mode: 0o700 });
  const installedPackageFiles = {};
  for (const name of [
    "physical_authority.py",
    "physical_lifecycle.py",
    "request_admission.py",
    "rebaseline_fence.py",
  ]) {
    const raw = "# owned offline native runtime fixture\n";
    write(path.join(fork, "lib", name), raw);
    installedPackageFiles[`lib/${name}`] = sha(raw);
  }

  const pins = {
    handoffId: "public-autostart-handoff",
    admissionStore: "C:\\private\\fmcad\\addin-admission\\admission.sqlite3",
    generation: { instance: "fixture-instance", epoch: "fixture-epoch" },
    process: { pid: identity.pid, birth: identity.birth },
    source: "offline-public-autostart",
    build: "fixture-build",
    endpoint,
  };
  const executable = path.join(base, "native-python-fixture");
  const nativeState = path.join(base, "native-state.json");
  const trace = path.join(base, "native-actions.txt");
  write(
    executable,
    `#!${process.execPath}
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const sha=b=>crypto.createHash("sha256").update(b).digest("hex");
const privateDir=${JSON.stringify(privateDirectory)};
const stateFile=${JSON.stringify(nativeState)};
const keyFile=${JSON.stringify(realm.keyReference.path)};
const trace=${JSON.stringify(trace)};
const operatorFile=path.join(privateDir,"runtime-rebaseline-operator.json");
const mapped=name=>{
 const value=String(name).replaceAll(String.fromCharCode(92),"/"),prefix="C:/private/";
 if(!value.startsWith(prefix))process.exit(89);
 return path.join(privateDir,...value.slice(prefix.length).split("/"));
};
let raw="";process.stdin.on("data",b=>raw+=b);process.stdin.on("end",()=>{
const e=JSON.parse(raw),action=e.action;
fs.appendFileSync(trace,action+"\\n");
const json=v=>process.stdout.write(JSON.stringify(v));
const readState=()=>fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile)):null;
const saveState=s=>fs.writeFileSync(stateFile,JSON.stringify(s),{mode:0o600});
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==="object"?
  Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
if(["begin","query","consume"].includes(action)){
 const operator=JSON.parse(fs.readFileSync(operatorFile,"utf8"));
 if(operator.database!==e.admissionStore)process.exit(86);
 const key=fs.readFileSync(keyFile),operatorKey=Buffer.from(operator.publicationVerifier.keyHex,"hex");
 if(!operatorKey.equals(key)||
   (e.keyId!==undefined&&(e.keyId!==operator.publicationVerifier.keyId||e.keyDigest!==sha(key))))
  process.exit(87);
 const expected={handoffId:e.runtimePins.handoffId,generation:e.descriptor.generation,
   physicalRuntime:e.descriptor.physicalRuntime,endpointURL:e.runtimePins.endpoint};
 if(JSON.stringify(operator.runtime)!==JSON.stringify(expected))process.exit(88);
 const q=JSON.parse(e.requestJson);let s=readState();
 if(action==="begin"){
  s={kind:"fmcad-provision-fence",version:1,state:"pending",binding:{
   requestId:q.requestId,fenceNonce:"fixture-native-fence",handoffId:q.handoffId,
   generation:e.descriptor.generation,physicalRuntime:e.descriptor.physicalRuntime,
   endpointURL:e.runtimePins.endpoint,store:q.store,oldHead:q.expectedHead,
   intentReferences:q.intentReferences,initiatorOperatorId:"offline-operator",
   writerGeneration:q.writerGeneration}};
  saveState(s);
 }
 if(!s){json({kind:"fmcad-provision-fence",version:1,state:"absent",requestId:q.requestId});return;}
 if(action==="consume"){
  const publication=JSON.parse(q.publicationJson),activation=JSON.parse(publication.activationBytes);
  const digest=sha(q.publicationJson),key=fs.readFileSync(keyFile);
  const expectedMac=crypto.createHmac("sha256",key).update("fmcad-posix-publication-v1\\0")
   .update(JSON.stringify(ordered({binding:s.binding,publicationDigest:digest}))).digest("hex");
  if(q.attestation.mac!==expectedMac)process.exit(85);
  const receipt={kind:"fmcad-rebaseline-consumed",version:1,fence:s.binding,
   activation:{requestId:s.binding.requestId,fenceNonce:s.binding.fenceNonce,
    newHead:activation.newHead,publicationDigest:digest,record:publication.record,
    initiatorOperatorId:s.binding.initiatorOperatorId},consumedBy:"offline-operator"};
  const receiptJson=JSON.stringify(receipt);
  s={...s,state:"consumed",publicationJson:q.publicationJson,receiptJson,
   receiptDigest:sha(receiptJson),receiptMac:crypto.createHmac("sha256",key)
    .update("fmcad-native-consume-v1\\0").update(receiptJson).digest("hex")};
  saveState(s);
 }
 json(s);return;
}
if(action==="prepare"){
 const directory=path.join(privateDir,e.attempt);fs.mkdirSync(directory,{mode:0o700});
 const raw=e.descriptorRaw;
 fs.writeFileSync(path.join(directory,"request.json"),raw,{mode:0o600});
 if(e.activationRaw!==undefined)
  fs.writeFileSync(path.join(directory,"activation.json"),e.activationRaw,{mode:0o600});
 process.stdout.write(sha(raw));return;
}
if(action==="grant"){
 const s=readState();
 if(!s||s.state!=="consumed")process.exit(83);
 const request=JSON.parse(fs.readFileSync(mapped(e.request),"utf8"));
 if(e.activationRaw!==undefined){
  const approved=JSON.parse(s.receiptJson).activation,a=JSON.parse(e.activationRaw);
  const expected={requestId:approved.requestId,fenceNonce:approved.fenceNonce,
   newHead:approved.newHead,publicationDigest:approved.publicationDigest,
   receiptDigest:s.receiptDigest};
  if(JSON.stringify(a)!==JSON.stringify(expected))process.exit(84);
 }
 fs.writeFileSync(mapped(e.output),JSON.stringify({...request,
  token:"offline-private-grant-".repeat(3)}),{mode:0o600});
 json({state:"granted",handoffId:request.handoffId});return;
}
if(action==="verify"){process.stdout.write(sha(fs.readFileSync(mapped(e.output))));return;}
process.exit(90);
});`,
    { mode: 0o700 },
  );
  fs.chmodSync(executable, 0o700);

  const native = {
    nativePython: "C:\\Python\\python.exe",
    mappedNativePython: executable,
    nativePythonSha256: sha(fs.readFileSync(executable)),
    installedForkDirectory: "C:\\fork",
    mappedInstalledForkDirectory: fork,
    installedPackageFiles,
    provisionPath: "C:\\private\\provision.json",
    localAppData: "C:\\private",
    nativePrivateDirectory: "C:\\private",
    mappedPrivateDirectory: privateDirectory,
    linuxGrantDirectory: grantsDirectory,
  };
  const physicalRuntime = {
    ...identity,
    version: "offline-native-root-fixture",
    source: pins.source,
    build: pins.build,
  };
  const profile = {
    version: 1,
    clientId,
    transport: "node",
    runtime: {
      kind: "fmcad-physical-grant",
      version: 1,
      handoffId: pins.handoffId,
      generation: pins.generation,
      endpointURL: endpoint,
      physicalRuntime,
    },
    nativeProvision: native,
  };
  const nativeOperatorFile = "C:\\private\\runtime-rebaseline-operator.json";
  write(path.join(privateDirectory, "runtime-rebaseline-operator.json"), {
    database: pins.admissionStore,
    runtime: {
      handoffId: pins.handoffId,
      generation: pins.generation,
      physicalRuntime,
      endpointURL: endpoint,
    },
    publicationVerifier: {
      keyId: realm.keyId,
      keyHex: fs.readFileSync(realm.keyReference.path).toString("hex"),
    },
  });

  const evidence = (name, value) => write(path.join(base, name), value);
  const committed = {
    state: "committed",
    handoffId: pins.handoffId,
    nextGeneration: pins.generation,
  };
  const ports = createNativeRuntimeRebaselineAuthorityPorts({
    store,
    pins,
    native,
    runtimeVersion: physicalRuntime.version,
    operatorId: "offline-operator",
    evidenceDirectory: base,
    publicationAuthority: {
      ...realm,
      nativeOperatorFile,
    },
    originalEvidence: {
      retiredProcess: evidence("retired.json", {
        exited: true,
        oldPidPresent: false,
        forceUsed: false,
        oldPid: 11,
        oldBirth: "retired-process",
      }),
      coldProcess: evidence("cold.json", {
        ...identity,
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
      sourceArchive: evidence("archive.bin", "offline native-root fixture"),
    },
    writer: {
      async withExclusiveWriter(work) {
        const file = path.join(base, "runtime-root-writer.lock");
        const fd = fs.openSync(file, "wx", 0o600);
        try {
          return await work({
            generation: randomUUID(),
            assertHeld() {
              if (fs.fstatSync(fd).ino !== fs.statSync(file).ino)
                throw new Error("Fixture writer lock changed");
            },
          });
        } finally {
          fs.closeSync(fd);
          fs.unlinkSync(file);
        }
      },
    },
  });
  await core.rebaselineRuntime(
    store,
    {
      requestId: "public-runtime-root",
      handoffId: pins.handoffId,
      expectedHead: core.literalRuntimeHead(store).digest,
    },
    core.createRuntimeRebaselineAuthority(ports),
  );
  write(path.join(store, "runtime-rebaseline-current-instance.json"), {
    buildHash,
    configHash,
    instance: identity,
  });
  write(path.join(store, "runtime-physical-profile.json"), profile);
  return {
    identity,
    nativeState,
    profilePath: path.join(store, "runtime-physical-profile.json"),
    trace,
  };
};
