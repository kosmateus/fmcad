import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const load = createRequire(
  path.resolve("tests/python-admission-observer.test.js"),
);
const root = path.resolve(__dirname, "../..");
const dist = path.join(root, "dist/src");
const { buildHash } = load(path.join(dist, "queue-instance")) as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { resolveRuntimePaths } = load(
  path.join(dist, "dist/config-platform"),
) as typeof import("../packages/node-adapters/src/config-platform/runtime-paths");
const { hash: canonicalHash } = load(
  path.join(dist, "dist/core/application/cad/json"),
) as typeof import("../packages/core/src/application/cad/json");
load(path.join(dist, "python"));
const { createProductionQueueAdmission, migrationAdmissionPreflight } = load(
  path.join(dist, "queue-admission"),
) as typeof import("../src/queue-admission");

const runtime = resolveRuntimePaths({
  anchor: path.join(dist, "queue-broker.js"),
}).runtime;

const { preparedObserver } = load("./fixtures/prepared-observer.cjs") as {
  preparedObserver(
    code: string,
    directory: string,
    preserveOrigin?: boolean,
    abiKind?: string,
  ): Observer;
};

test("production migration preflight certifies exact receipt bytes with the installed checker and no send", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-observer-admission-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const code =
    "value: int = 1\ndef run(context: str) -> None:\n    print(value, context)\n";
  const prepared = preparedObserver(code, directory);
  const descriptor = await migrationAdmissionPreflight(prepared);
  assert.deepEqual(
    {
      version: descriptor.version,
      production: descriptor.production,
      scopedAtomicObservation: descriptor.scopedAtomicObservation,
      finalByteCertificate: descriptor.finalByteCertificate,
      status: descriptor.status,
    },
    {
      version: 1,
      production: true,
      scopedAtomicObservation: true,
      finalByteCertificate: true,
      status: "passed",
    },
  );
  assert.equal(descriptor.buildHash, buildHash());
  assert.equal(
    descriptor.sourceHash,
    prepared.pythonArtifact.units.find((unit) => unit.role === "user")!.sha256,
  );
  assert.equal(descriptor.artifactHash, prepared.pythonArtifact.artifactHash);
  assert.equal(
    descriptor.originArtifactHash,
    prepared.pythonArtifact.context.origin.artifactHash,
  );
  assert.equal(
    descriptor.originSourceHash,
    prepared.pythonArtifact.context.origin.sha256,
  );
  assert.deepEqual(
    descriptor.originUnitHashes,
    prepared.pythonArtifact.context.origin.units,
  );
  assert.equal(descriptor.observationKind, "atomic_holder_status");
  assert.equal(
    descriptor.observationTargetJobId,
    prepared.record.binding.observationTargetJobId,
  );
  assert.equal(
    descriptor.observationIdentityHash,
    prepared.record.binding.observationIdentityHash,
  );
  assert.equal(
    descriptor.atomicRuntimeAbiHash,
    prepared.record.binding.atomicRuntimeAbiHash,
  );
  assert.equal(
    descriptor.atomicRuntimeAbiKind,
    prepared.record.atomicRuntimeAbi.kind,
  );
  assert.deepEqual(
    descriptor.abiPinnedUnits,
    prepared.record.atomicRuntimeAbi.abiPinnedUnits,
  );
  assert.equal(descriptor.abiSourceReceiptCount, 2);
  assert.deepEqual(
    descriptor.executedUnits.map((unit) => unit.filename),
    prepared.record.atomicRuntimeAbi
      ? prepared.pythonArtifact.context.origin.units.map(
          (unit) => unit.filename,
        )
      : [],
  );
  assert.equal(
    descriptor.checkedUnits.length,
    prepared.pythonArtifact.units.length,
  );
  for (const key of [
    "checkerFingerprint",
    "sourceModuleHash",
    "checkerHash",
    "definitionsHash",
    "configHash",
    "typingHash",
  ] as const)
    assert.match(text(descriptor[key]), /^[a-f0-9]{64}$/u, key);
  assert.equal(fs.existsSync(prepared.record.receipt), false);
});

test("production preflight refuses a receipt without its original unit/context manifest", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-observer-origin-required-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const prepared = preparedObserver(
    "value: int = 1\ndef run(context: str) -> None:\n    print(value, context)\n",
    directory,
    false,
  );
  await assert.rejects(migrationAdmissionPreflight(prepared), {
    code: "PYTHON_ADMISSION_UNAVAILABLE",
  });
  assert.equal(fs.existsSync(prepared.record.receipt), false);
});

test("production preflight refuses a missing or changed original ABI proof before checking or sending", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-observer-abi-proof-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const missing = preparedObserver(
    "value: int = 1\ndef run(context: str) -> None:\n    print(value, context)\n",
    directory,
  );
  Reflect.deleteProperty(missing.record, "atomicRuntimeAbi");
  delete missing.record.binding.atomicRuntimeAbiHash;
  await assert.rejects(migrationAdmissionPreflight(missing), {
    code: "PYTHON_ADMISSION_UNAVAILABLE",
  });
  const changed = preparedObserver(
    "value: int = 1\ndef run(context: str) -> None:\n    print(value, context)\n",
    directory,
  );
  changed.record.atomicRuntimeAbi.abiPinnedUnits[0]!.sha256 = "0".repeat(64);
  changed.record.binding.atomicRuntimeAbiHash = canonicalHash(
    changed.record.atomicRuntimeAbi,
  );
  await assert.rejects(migrationAdmissionPreflight(changed), {
    code: "BUILD_CHANGED",
  });
  const misbound = preparedObserver(
    "value: int = 1\ndef run(context: str) -> None:\n    print(value, context)\n",
    directory,
  );
  misbound.record.atomicRuntimeAbi.identityHash = "0".repeat(64);
  misbound.record.binding.atomicRuntimeAbiHash = canonicalHash(
    misbound.record.atomicRuntimeAbi,
  );
  await assert.rejects(migrationAdmissionPreflight(misbound), {
    code: "PYTHON_ADMISSION_UNAVAILABLE",
  });
  const wrongOrigin = preparedObserver(
    "value: int = 1\ndef run(context: str) -> None:\n    print(value, context)\n",
    directory,
  );
  wrongOrigin.record.binding.pythonOriginHash = "0".repeat(64);
  await assert.rejects(migrationAdmissionPreflight(wrongOrigin), {
    code: "WORKFLOW_ARTIFACT_CHANGED",
  });
  assert.equal(fs.existsSync(missing.record.receipt), false);
  assert.equal(fs.existsSync(changed.record.receipt), false);
  assert.equal(fs.existsSync(misbound.record.receipt), false);
  assert.equal(fs.existsSync(wrongOrigin.record.receipt), false);
});

test("production preflight accepts the legacy witness body without synthetic receipt unit groups", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-observer-legacy-abi-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const prepared = preparedObserver(
    "def run(context: str) -> None:\n    print(context)\n",
    directory,
    true,
    "legacy-full-program-witness-v1",
  );
  const descriptor = await migrationAdmissionPreflight(prepared);
  assert.equal(descriptor.status, "passed");
  assert.equal(
    descriptor.atomicRuntimeAbiKind,
    "legacy-full-program-witness-v1",
  );
  const mismatchedWitness = preparedObserver(
    "def run(context: str) -> None:\n    print(context)\n",
    directory,
    true,
    "legacy-full-program-witness-v1",
  );
  mismatchedWitness.record.atomicRuntimeAbi.witness.sourceHash = "0".repeat(64);
  mismatchedWitness.record.binding.atomicRuntimeAbiHash = canonicalHash(
    mismatchedWitness.record.atomicRuntimeAbi,
  );
  await assert.rejects(migrationAdmissionPreflight(mismatchedWitness), {
    code: "RECEIPT_MISMATCH",
  });
  assert.equal(fs.existsSync(prepared.record.receipt), false);
  assert.equal(fs.existsSync(mismatchedWitness.record.receipt), false);
});

test("production observer rejects a real checker type error before a physical send", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-observer-admission-negative-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const prepared = preparedObserver(
    'value: int = "bad"\ndef run(context: str) -> None:\n    print(value, context)\n',
    directory,
  );
  await assert.rejects(migrationAdmissionPreflight(prepared), (error) => {
    assert.equal(field(error, "code"), "PYTHON_CHECK_REJECTED");
    assert.equal(field(field(error, "pythonCheck"), "status"), "failed");
    assert.equal(field(error, "executionOutcome"), "not_started");
    assert.equal(field(error, "userScriptSubmitted"), false);
    return true;
  });
  assert.equal(fs.existsSync(prepared.record.receipt), false);
});

test("synchronous observer fence refuses source mutation after a real certificate", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-observer-admission-fence-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const prepared = preparedObserver(
    "value: int = 1\ndef run(context: str) -> None:\n    print(value, context)\n",
    directory,
  );
  const production = createProductionQueueAdmission(runtime);
  await production.checkPrepared(prepared);
  record(record(prepared.outgoing.params)["arguments"])["code"] =
    "value: int = 2\n";
  assert.throws(() => production.fencePrepared(prepared, buildHash()), {
    code: "WORKFLOW_ARTIFACT_CHANGED",
  });
});

test(
  "offline installed package exposes the same real migration admission preflight",
  { timeout: 30000 },
  (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "fmcad-installed-observer-admission-"),
    );
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const packed = spawnSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = path.join(directory, JSON.parse(packed.stdout)[0].filename);
    const consumer = path.join(directory, "consumer");
    fs.mkdirSync(consumer);
    const installed = spawnSync(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        consumer,
        tarball,
      ],
      { cwd: consumer, encoding: "utf8", timeout: 20000 },
    );
    assert.equal(installed.status, 0, installed.stderr);
    const script = String.raw`
const assert=require('node:assert/strict'),path=require('node:path');
const root=path.join(process.cwd(),'node_modules/fmcad/dist/src');
const {buildHash,hash,prepareReceiptScript}=require(path.join(root,'queue-instance'));
const {migrationAdmissionPreflight}=require(path.join(root,'queue-admission'));
const {cadBundleUnits}=require(path.join(root,'python'));
const {resolveRuntimePaths}=require(path.join(root,'dist/config-platform'));
const canonicalHash=value=>require(path.join(root,'dist/core/application/cad/json')).hash(value);
const {preparePythonArtifact,pythonArtifactManifest,retainPythonOrigin}=require(path.join(root,'python'));
const rpcId='fmcad-installed-observer';
function prepared(code){
  const installation=resolveRuntimePaths({anchor:path.join(root,'queue-broker.js')}).installation;
  const abiPaths=new Set(['runtime/python/fmcad/adapters/fusion/atomic.py','runtime/python/fmcad/adapters/fusion/identity.py',
    'runtime/python/fmcad/adapters/fusion/values.py','runtime/python/fmcad/domain/values.py','assets/cad/core.py']);
  const abiPinnedUnits=cadBundleUnits(installation).filter(unit=>abiPaths.has(unit.filename))
    .map(unit=>({id:unit.id,filename:unit.filename,sha256:hash(unit.source)}));
  const atomicRuntimeAbi={version:1,kind:'original-unit-manifest-v1',jobId:'blocked-job',requestId:'blocked-request',
    jobHash:'b'.repeat(64),originalBuildHash:'c'.repeat(64),identityHash:'a'.repeat(64),abiPinnedUnits,
    sourceReceipts:[{rpcId:'1'.repeat(36),sourceHash:'d'.repeat(64)},{rpcId:'2'.repeat(36),sourceHash:'e'.repeat(64)}]};
  const atomicRuntimeAbiHash=canonicalHash(atomicRuntimeAbi);
  const originContext={kind:'atomic-status-readonly-v1',executedUnits:['runtime/python/fmcad/adapters/fusion/atomic_status.py','<fmcad-wrapper>'],
    abiPinnedUnits,atomicRuntimeAbiHash};
  const originalArtifact=preparePythonArtifact([
    {id:'atomic-status',filename:'runtime/python/fmcad/adapters/fusion/atomic_status.py',source:code,role:'runtime'},
    {id:'wrapper',filename:'<fmcad-wrapper>',source:'run("")\n',role:'wrapper'}],
    {context:originContext,request:{operation:'atomic_status'}});
  const finalCode=originalArtifact.script;
  const original={jsonrpc:'2.0',id:'caller',method:'tools/call',params:{name:'execute_python',arguments:{code:finalCode,persistent:false}}};
  const binding={jobId:'installed-observer',rpcId,requestHash:hash(JSON.stringify(original)),buildHash:buildHash(),sourceHash:hash(finalCode),
    observationKind:'atomic_holder_status',observationTargetJobId:'blocked-job',observationIdentityHash:'a'.repeat(64),
    atomicRuntimeAbiHash,pythonOriginHash:pythonArtifactManifest(originalArtifact).artifactHash};
  const receipt=path.join(process.cwd(),'never-written-receipt.json');
  const pythonArtifact=retainPythonOrigin(prepareReceiptScript(finalCode,false,receipt,binding,{mapPath:file=>file}),pythonArtifactManifest(originalArtifact));
  const outgoing=structuredClone(original);outgoing.id='fmcad:'+rpcId;outgoing.params.arguments.code=pythonArtifact.script;
  const record={binding,atomicRuntimeAbi,receipt,request:{jsonrpc:'2.0',id:original.id,method:original.method},
    wireRequest:{jsonrpc:'2.0',id:outgoing.id,method:outgoing.method},terminal:false,method:outgoing.method,
    pythonArtifact:{version:pythonArtifact.version,sha256:pythonArtifact.sha256,artifactHash:pythonArtifact.artifactHash,
      sourceMap:pythonArtifact.sourceMap,context:pythonArtifact.context,request:pythonArtifact.request,
      units:pythonArtifact.units.map(({id,filename,role,sha256})=>({id,filename,role,sha256}))}};
  return {outgoing,pythonArtifact,record,rpcId,dispatchTimeoutMs:30000};
}
(async()=>{
  const code='value: int = 1\ndef run(context: str) -> None:\n    print(value, context)\n';
  const good=prepared(code);
  const descriptor=await migrationAdmissionPreflight(good);
  assert.equal(descriptor.production,true);assert.equal(descriptor.status,'passed');
  assert.equal(descriptor.buildHash,buildHash());assert.equal(descriptor.artifactHash,good.pythonArtifact.artifactHash);
  assert.ok(descriptor.originUnitHashes.some(unit=>unit.filename==='runtime/python/fmcad/adapters/fusion/atomic_status.py'));
  const bad=prepared('value: int = "bad"\ndef run(context: str) -> None:\n    print(value, context)\n');
  await assert.rejects(migrationAdmissionPreflight(bad),error=>error.code==='PYTHON_CHECK_REJECTED'&&error.pythonCheck.status==='failed');
  assert.equal(require('node:fs').existsSync(good.record.receipt),false);
  assert.equal(require('node:fs').existsSync(bad.record.receipt),false);
  process.stdout.write(JSON.stringify({status:'passed',checker:descriptor.checker,installed:true}));
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: consumer,
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: "passed",
      checker: "basedpyright",
      installed: true,
    });
  },
);

function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function field(value: unknown, key: string): unknown {
  return record(value)[key];
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

type Observer = import("../src/queue-admission").ScopedPrepared & {
  pythonArtifact: {
    context: {
      origin: {
        artifactHash: string;
        sha256: string;
        units: { filename: string }[];
      };
    };
  };
  record: {
    receipt: string;
    atomicRuntimeAbi: import("../src/queue-admission").AtomicRuntimeAbi & {
      witness: NonNullable<
        import("../src/queue-admission").AtomicRuntimeAbi["witness"]
      >;
    };
  };
};
