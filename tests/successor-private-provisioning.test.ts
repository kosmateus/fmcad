import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import ts from "typescript";

const worker = ts.transpileModule(
  fs.readFileSync("src/queue-epoch-successor-worker.ts", "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const token = 'synthetic-private-"quoted"\\token-do-not-persist-'.repeat(2);
const dto = {
  capability: "get_open_document_metadata",
  owner: "beneficiary",
  endpoint: "http://127.0.0.1:8765/admission/v1",
  token,
  pid: 42,
  birth: "birth",
  instance: "addin-instance",
  epoch: "addin-epoch",
  source: "source",
  build: "build",
};

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "successor-private-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const audit = path.join(root, "epoch-successions", "request");
  fs.mkdirSync(audit, { recursive: true });
  const binding = Object.fromEntries(
    Object.entries(dto).filter(([key]) => key !== "token"),
  );
  const authority: Record<string, unknown> = {
    version: 1,
    kind: "owner-authenticated-dead-epoch-successor",
    nonce: "nonce",
    clientId: "authorizing-cli",
    expectedProcess: { pid: dto.pid, birth: dto.birth },
    frozenMetadata: {
      version: 1,
      purpose: "dead-frozen-predecessor-metadata-v1",
      beneficiary: dto.owner,
      metadataRequestId: "metadata-request",
      provisioning: binding,
    },
  };
  const input: Record<string, unknown> = {
    dir: root,
    audit,
    nonce: "nonce",
    cfg: { backend: "addin" },
    addinMetadataAdmission: { ...dto },
  };
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  function publish() {
    const file = path.join(audit, "authority.json");
    fs.writeFileSync(file, JSON.stringify(authority));
    write("active-epoch-succession.json", {
      version: 1,
      authority: {
        path: file,
        sha256: createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex"),
      },
    });
    const guard = {
      kind: "dead-epoch-successor",
      nonce: "nonce",
      audit,
      clientId: authority["clientId"],
    };
    write("recovery.lock", guard);
    write("atomic-migration.lock", guard);
  }
  publish();
  fs.writeFileSync(path.join(root, "worker.cjs"), worker);
  fs.writeFileSync(
    path.join(root, "queue-instance.js"),
    `
exports.processBirth=()=> "boot:tick";
exports.readJson=file=>JSON.parse(require("fs").readFileSync(file,"utf8"));
`,
  );
  fs.writeFileSync(
    path.join(root, "queue-atomic-migration-files.js"),
    `
exports.exclusive=(file,value)=>require("fs").writeFileSync(file,JSON.stringify(value),{flag:"wx"});
`,
  );
  fs.writeFileSync(
    path.join(root, "queue-broker.js"),
    `
exports.serve=async(cfg,options)=>{
 const fs=require("fs"),path=require("path"),p=options.addinMetadataAdmission;
 fs.writeFileSync(path.join(options.dir,"served.json"),JSON.stringify({
  supplied:!!p, tokenMatched:p?.token===${JSON.stringify(token)},
  binding:p?Object.fromEntries(Object.entries(p).filter(([k])=>k!=="token")):null,
  cfg, autoReconcile:options.autoReconcile, nonce:options.deadEpochSuccessorNonce
 }));
 if(cfg.fail)throw Object.assign(Error(p.token),{code:p.token});
 fs.writeFileSync(path.join(options.dir,"broker.lock"),JSON.stringify({pid:process.pid}));
 if(cfg.closeFailure)process.nextTick(()=>process.emit("SIGTERM"));
 return {buildHash:"runtime",close:async()=>{if(cfg.closeFailure)throw Object.assign(Error(p.token),{code:p.token});}};
};
`,
  );
  function run(raw = JSON.stringify(input), preload?: string) {
    return spawnSync(
      process.execPath,
      [
        ...(preload ? ["--require", preload] : []),
        path.join(root, "worker.cjs"),
      ],
      {
        input: raw,
        encoding: "utf8",
        timeout: 10000,
      },
    );
  }
  function noLeaks(output: { stdout: string; stderr: string }) {
    assert.ok(!output.stdout.includes(token));
    assert.ok(!output.stderr.includes(token));
    const visit = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) visit(p);
        else if (!p.endsWith(".js") && !p.endsWith(".cjs")) {
          assert.ok(!fs.readFileSync(p, "utf8").includes(token), p);
          const inspect = (value: unknown): void => {
            if (typeof value === "string") assert.ok(!value.includes(token), p);
            else if (value && typeof value === "object")
              for (const [key, child] of Object.entries(value)) {
                assert.ok(!key.includes(token), p);
                inspect(child);
              }
          };
          inspect(JSON.parse(fs.readFileSync(p, "utf8")));
        }
      }
    };
    visit(root);
  }
  return { root, audit, authority, input, publish, run, noLeaks, binding };
}

test("private worker stdin binds metadata provisioning before claim and passes serve options", (t) => {
  const f = fixture(t),
    result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const seen = JSON.parse(
    fs.readFileSync(path.join(f.root, "served.json"), "utf8"),
  );
  assert.deepEqual(seen, {
    supplied: true,
    tokenMatched: true,
    binding: f.binding,
    cfg: { backend: "addin" },
    autoReconcile: false,
    nonce: "nonce",
  });
  assert.ok(fs.existsSync(path.join(f.audit, "worker-claim.json")));
  assert.ok(fs.existsSync(path.join(f.audit, "worker-ready.json")));
  f.noLeaks(result);
});

for (const problem of [
  "missing",
  "owner",
  "pin",
  "token",
  "extra",
  "nonce",
  "profile",
  "authority-hash",
  "audit",
  "guard",
  "process",
  "beneficiary",
  "legacy-with-dto",
  "cfg-token",
  "invalid-endpoint",
  "wrong-port",
  "worker-journal",
]) {
  test(`private worker refuses ${problem} before claim or serve`, (t) => {
    const f = fixture(t);
    const value = { ...dto };
    if (problem === "missing") delete f.input["addinMetadataAdmission"];
    if (problem === "owner") value.owner = "foreign";
    if (problem === "pin") value.source = "foreign";
    if (problem === "token") value.token = "bad\n" + token;
    if (problem === "cfg-token") f.input["cfg"] = { token };
    if (problem === "worker-journal")
      f.input["workerJournal"] = path.join(
        f.audit,
        "retained-evaluator-handoff",
      );
    if (problem === "wrong-port") {
      value.endpoint = "http://127.0.0.1:27182/admission/v1";
      (f.authority["frozenMetadata"] as Record<string, unknown>)[
        "provisioning"
      ] = {
        ...f.binding,
        endpoint: value.endpoint,
      };
    }
    if (problem === "invalid-endpoint") {
      value.endpoint = "https://remote.invalid/admission/v1";
      (f.authority["frozenMetadata"] as Record<string, unknown>)[
        "provisioning"
      ] = {
        ...f.binding,
        endpoint: value.endpoint,
      };
    }
    if (problem === "extra")
      f.input["addinMetadataAdmission"] = { ...value, injected: true };
    else if (problem !== "missing") f.input["addinMetadataAdmission"] = value;
    if (problem === "nonce") f.input["nonce"] = "foreign";
    if (problem === "profile") {
      const profile = f.authority["frozenMetadata"] as Record<string, unknown>;
      profile["purpose"] = "wrong";
    }
    if (problem === "process")
      f.authority["expectedProcess"] = { pid: 43, birth: dto.birth };
    if (problem === "beneficiary")
      (f.authority["frozenMetadata"] as Record<string, unknown>)[
        "beneficiary"
      ] = "foreign";
    if (problem === "legacy-with-dto") delete f.authority["frozenMetadata"];
    f.publish();
    if (problem === "authority-hash")
      fs.appendFileSync(path.join(f.audit, "authority.json"), " ");
    if (problem === "audit") f.input["audit"] = f.root;
    if (problem === "guard") fs.unlinkSync(path.join(f.root, "recovery.lock"));
    const result = f.run();
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), "INVALID_SUCCESSOR_PROVISIONING");
    assert.ok(!fs.existsSync(path.join(f.audit, "worker-claim.json")));
    assert.ok(!fs.existsSync(path.join(f.root, "served.json")));
    f.noLeaks(result);
  });
}

test("legacy worker without private DTO retains its serve contract", (t) => {
  const f = fixture(t);
  delete f.authority["frozenMetadata"];
  delete f.input["addinMetadataAdmission"];
  f.publish();
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.root, "served.json"), "utf8"))
      .supplied,
    false,
  );
  f.noLeaks(result);
});

test("metadata worker redacts host errors from stderr and durable failure artifacts", (t) => {
  const f = fixture(t);
  f.input["cfg"] = { fail: true };
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "SUCCESSOR_START_FAILED");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.audit, "worker-error.json"), "utf8"))
      .code,
    "SUCCESSOR_START_FAILED",
  );
  f.noLeaks(result);
});

test("malformed private stdin never echoes JSON excerpts or creates a claim", (t) => {
  const f = fixture(t),
    result = f.run('{"token":"' + token);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "INVALID_SUCCESSOR_STARTUP_JSON");
  assert.ok(!fs.existsSync(path.join(f.audit, "worker-claim.json")));
  f.noLeaks(result);
});

test("authority hashing uses the exact bytes parsed despite a changing read source", (t) => {
  const f = fixture(t);
  const preload = path.join(f.root, "race.cjs");
  fs.writeFileSync(
    preload,
    `
const fs=require("fs"), original=fs.readFileSync;
let reads=0;
fs.readFileSync=function(file,...args){
 const bytes=original.call(this,file,...args);
 if(String(file)===${JSON.stringify(path.join(f.audit, "authority.json"))}){
  reads++;
  fs.writeFileSync(${JSON.stringify(path.join(f.root, "read-count.json"))},JSON.stringify(reads));
  if(reads===1){
   const authority=JSON.parse(bytes.toString());
   authority.frozenMetadata.metadataRequestId="swapped-request";
   const changed=Buffer.from(JSON.stringify(authority));
   return args[0]==="utf8"?changed.toString():changed;
  }
 }
 return bytes;
};
`,
  );
  const result = f.run(JSON.stringify(f.input), preload);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "INVALID_SUCCESSOR_PROVISIONING");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.root, "read-count.json"), "utf8")),
    1,
  );
  assert.ok(!fs.existsSync(path.join(f.audit, "worker-claim.json")));
  assert.ok(!fs.existsSync(path.join(f.root, "served.json")));
  f.noLeaks(result);
});

test("metadata close failure cannot expose an untrusted error code", (t) => {
  const f = fixture(t);
  f.input["cfg"] = { closeFailure: true };
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.trim(), "Broker remains reserved: CLOSE_REFUSED");
  f.noLeaks(result);
});

test("a second frozen worker cannot escape its existing claim via another journal", (t) => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const claim = fs.readFileSync(
    path.join(f.audit, "worker-claim.json"),
    "utf8",
  );
  const served = fs.readFileSync(path.join(f.root, "served.json"), "utf8");
  const alternate = path.join(f.audit, "retained-evaluator-handoff");
  fs.mkdirSync(alternate);
  f.input["workerJournal"] = alternate;
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "INVALID_SUCCESSOR_PROVISIONING");
  assert.deepEqual(fs.readdirSync(alternate), []);
  assert.equal(
    fs.readFileSync(path.join(f.audit, "worker-claim.json"), "utf8"),
    claim,
  );
  assert.equal(
    fs.readFileSync(path.join(f.root, "served.json"), "utf8"),
    served,
  );
  f.noLeaks(result);
});
