import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import nodePath from "node:path";
const sourceDirectory = nodePath.join(process.cwd(), "tests");
const load = createRequire(
  nodePath.join(sourceDirectory, "local-build-recovery.test.js"),
);

const fs = load("node:fs") as typeof import("node:fs");
const os = load("node:os") as typeof import("node:os");
const path = load("node:path") as typeof import("node:path");
const { spawnSync } = load(
  "node:child_process",
) as typeof import("node:child_process");
const { createHash } = load("node:crypto") as typeof import("node:crypto");
const { inspect, EXPECTED } = load(
  "../scripts/recover-local-build-preflight",
) as {
  EXPECTED: {
    jobId: string;
    requestId: string;
    clientId: string;
    sequenceId: string;
    buildHash: string;
    brokerNonce: string;
  };
  inspect(options: {
    dir: string;
    root: string;
    archive: string;
    status: Record<string, unknown>;
    control: Record<string, unknown>;
    alive: () => boolean;
    command: () => string[];
  }): Record<string, unknown>;
};
const { archiveFiles } = load(
  "../scripts/install-queue-phases",
) as typeof import("../scripts/devtools/install-queue-phases");
const root = path.resolve(sourceDirectory, "..");
const archive =
  process.env["FMCAD_BASELINE_ARCHIVE"] ||
  path.join(sourceDirectory, "fixtures/legacy-local-preflight.tgz");
const hash = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");
let frozenRoot: string | undefined;
function legacyProfile() {
  if (frozenRoot) return frozenRoot;
  const files = archiveFiles(archive);
  frozenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qlegacy-profile-"));
  for (const [name, bytes] of files) {
    if (name !== "package.json" && !/^(src|assets|bin)\//.test(name)) continue;
    const file = path.join(frozenRoot, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  return frozenRoot;
}
test.after(() => {
  if (frozenRoot) fs.rmSync(frozenRoot, { recursive: true, force: true });
});

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlocalproof-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const broker = {
    pid: 99999,
    birth: "mock:99999",
    nonce: EXPECTED.brokerNonce,
    protocol: 2,
  };
  const instance = {
    pid: 37700,
    birth: "mock-fusion",
    version: "mock-version",
  };
  const job: {
    id: string;
    requestId: string;
    state: string;
    clientId: string;
    sequenceId: string;
    kind: string;
    details: { reason: string };
    request: { argv: string[]; buildHash: string };
    dispatch?: { rpcCount: number; completedCount: number };
  } = {
    id: EXPECTED.jobId,
    requestId: EXPECTED.requestId,
    state: "needs_reconciliation",
    clientId: EXPECTED.clientId,
    sequenceId: EXPECTED.sequenceId,
    kind: "command",
    details: { reason: "BUILD_CHANGED" },
    request: { argv: ["run", "owned-test.py"], buildHash: EXPECTED.buildHash },
  };
  const state = {
    paused: true,
    active: job.id,
    blocked: { id: job.id, reason: "BUILD_CHANGED" },
    lease: { id: job.sequenceId, clientId: job.clientId },
    jobs: { [job.id]: job },
  };
  const directory = path.join(dir, "jobs", job.id);
  fs.mkdirSync(directory, { recursive: true });
  const rpcId = "12345678-1234-1234-1234-123456789abc";
  const preflight = {
    version: 2,
    jobId: job.id,
    buildHash: EXPECTED.buildHash,
    instance,
    binding: {
      jobId: job.id,
      buildHash: EXPECTED.buildHash,
      rpcId,
      requestHash: hash("preflight:" + job.id + ":" + rpcId),
    },
    receipt: path.join(directory, "preflight-" + rpcId + ".receipt.json"),
  };
  const save = () => {
    for (const [file, value] of [
      ["broker.lock", broker],
      ["instance.json", { buildHash: EXPECTED.buildHash, instance }],
      ["queue-state.json", state],
      ["jobs/" + job.id + "/preflight-start.json", preflight],
    ] as const)
      fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
  };
  save();
  const status = {
    buildHash: EXPECTED.buildHash,
    held: "BUILD_CHANGED",
    active: job.id,
    stopping: false,
    lease: state.lease,
  };
  const control = { instanceId: broker.nonce, activeOperations: 0 };
  const producer = legacyProfile();
  return {
    dir,
    directory,
    state,
    status,
    control,
    job,
    preflight,
    save,
    check: () =>
      inspect({
        dir,
        root: producer,
        archive,
        status,
        control,
        alive: () => true,
        command: () => [
          "node",
          path.join(producer, "src/queue-autostart-worker.js"),
        ],
      }),
  };
}

test("narrow legacy proof classifies only the known local guard, not an SDK completion", (t) => {
  const f = fixture(t),
    proof = f.check();
  assert.equal(proof["classification"], "not_started");
  assert.equal(proof["fusionCalls"], 0);
  assert.equal(proof["scriptReplay"], false);
  assert.equal(typeof proof["source"], "string");
  assert.match(
    proof["source"] as string,
    /not a native SDK completion receipt/,
  );
});

test("any extra probe/worker/RPC evidence prevents legacy local-only recovery", (t) => {
  for (const filename of [
    "worker-start.json",
    "worker-result.json",
    "preflight.json",
    "rpc-other.json",
    "remote-other.json",
  ]) {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.directory, filename), "{}");
    assert.throws(f.check, /Unexpected receipt/);
  }
});

test("wrong binding, owner, sequence, dispatch count or admitted SDK operation is rejected", (t) => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.job.clientId = "other-owner";
    },
    (f) => {
      f.job.sequenceId = "other-sequence";
    },
    (f) => {
      f.job.dispatch = { rpcCount: 1, completedCount: 0 };
    },
    (f) => {
      f.control.activeOperations = 1;
    },
    (f) => {
      f.preflight.binding.requestHash = "wrong";
    },
    (f) => {
      f.state.blocked.reason = "INSTANCE_UNAVAILABLE";
    },
  ];
  for (const mutate of mutations) {
    const f = fixture(t);
    mutate(f);
    f.save();
    assert.throws(f.check);
  }
});

test("the frozen legacy producer reproduces the exact false-hold signature without submitting SDK", (t) => {
  const parent = path.join(root, ".test-artifacts");
  fs.mkdirSync(parent, { recursive: true });
  const work = fs.mkdtempSync(path.join(parent, "legacy-local-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const runtime = path.join(work, "runtime");
  fs.mkdirSync(runtime);
  for (const [name, bytes] of archiveFiles(archive)) {
    if (name !== "package.json" && !/^(src|assets|bin)\//.test(name)) continue;
    const file = path.join(runtime, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlegacy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = `const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const root=process.argv[1],dir=process.argv[2];let probes=0,sdk=0;
const qi=require(path.join(root,'src/queue-instance'));
const physical={server:{timeoutMs:1000},_parse:JSON.parse,async _post(){sdk++;throw Error('No SDK allowed');},async callTool(){probes++;return {failed:false,text:'FMCAD_QUEUE_INSTANCE '+JSON.stringify({pid:99,birth:'mock:99',version:'mock',activeCommand:'SelectCommand',documents:[]})};}};
(async()=>{const broker=await require(path.join(root,'src/queue-broker')).serve({backend:'mcp',timeoutMs:1000},{dir,confirmOwnership:true,createBackend:()=>physical,pollMs:500});
const {request}=require(path.join(root,'src/queue-connection'));const auth={clientId:'a',clientToken:'private-a'};await request(dir,{action:'register',...auth});
const file=path.join(dir,'local.py');fs.writeFileSync(file,'def run(context): pass\\n');const old=qi.buildHash();
const job=await request(dir,{action:'submit',auth,request:{kind:'command',requestId:randomUUID(),argv:['run',file],cwd:dir,timeoutMs:1000,buildHash:old}});
fs.appendFileSync(path.join(root,'src/help.js'),'\\n// controlled offline build change\\n');
for(let i=0;i<200;i++){const value=await request(dir,{action:'result',auth,jobId:job.id});if(value.job.state==='needs_reconciliation'){const s=broker.status();console.log(JSON.stringify({held:s.held,state:value.job.state,dispatch:value.job.dispatch||null,files:fs.readdirSync(path.join(dir,'jobs',job.id)),probes,sdk}));process.exit(0);}await new Promise(r=>setTimeout(r,10));}throw Error('Signature not reproduced');})().catch(e=>{console.error(e);process.exit(1);});`;
  const child = spawnSync(process.execPath, ["-e", source, runtime, dir], {
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim()) as {
    held: string;
    state: string;
    dispatch: unknown;
    files: string[];
    probes: number;
    sdk: number;
  };
  assert.equal(result.held, "BUILD_CHANGED");
  assert.equal(result.state, "needs_reconciliation");
  assert.equal(result.dispatch, null);
  assert.deepEqual(result.files, ["preflight-start.json"]);
  assert.equal(
    result.probes,
    1,
    "Only controlled startup probe, never preflight",
  );
  assert.equal(result.sdk, 0);
});
