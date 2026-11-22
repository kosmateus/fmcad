import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createNativePhysicalGenerationProvision,
  PhysicalGenerationProvisionError,
} from "../packages/node-adapters/src/execution/physical-generation-provision";
import type { PhysicalGenerationDescriptor } from "../packages/node-adapters/src/execution/physical-generation";

const platformOptions = {
  skip: process.platform !== "linux" && "WSL/Linux private operator adapter",
};

const descriptor: PhysicalGenerationDescriptor = {
  kind: "fmcad-physical-grant",
  version: 1,
  handoffId: "fresh-handoff",
  generation: { instance: "physical-instance", epoch: "physical-epoch" },
  brokerOwner: {
    pid: 1234,
    birth: "boot:123456",
    nonce: "fresh-owner-nonce",
    clientId: "operator-client",
    queueDirectory: "/home/operator/.local/state/fmcad/fresh-queue",
  },
  endpointURL: "http://127.0.0.1:8765",
  physicalRuntime: {
    pid: 5678,
    birth: "134397688915365397",
    version: "1.6.0",
    source: "approved-source",
    build: "approved-build",
  },
};

/** A separate executable models the private local CLI boundary, not Fusion.
 * These tests issue no real grants and never contact the physical runtime. */
function fixture(mode = "success") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provision-port-"));
  const mapped = path.join(directory, "native");
  const linux = path.join(directory, "linux");
  fs.mkdirSync(mapped, { mode: 0o700 });
  fs.mkdirSync(linux, { mode: 0o700 });
  const trace = path.join(directory, "trace.jsonl");
  const executable = path.join(directory, "python.exe");
  const secret = "fake-test-token-never-diagnostics";
  fs.writeFileSync(
    executable,
    `#!${process.execPath}
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const args=process.argv.slice(2),root=${JSON.stringify(mapped)},mode=${JSON.stringify(mode)};
const nativePath=p=>path.join(root,...p.split("\\\\").slice(3));
const digest=b=>crypto.createHash("sha256").update(b).digest("hex");
const record=x=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(x)+"\\n");
let input=[];process.stdin.on("data",x=>input.push(x));process.stdin.on("end",()=>{
const raw=Buffer.concat(input);
if(args[2]==="-c"&&args[3].includes("root=Path")){
 const attempt=args[5],dir=path.join(root,attempt);fs.mkdirSync(dir,{mode:448});
 fs.writeFileSync(path.join(dir,"request.json"),raw,{flag:"wx",mode:384});
 record({operation:"prepare",descriptor:JSON.parse(raw),cwd:process.cwd(),env:process.env,argsWithoutCode:[...args.slice(0,3),...args.slice(4)]});
 console.log(digest(raw));return;
}
if(args[2]==="-m"){
 const request=nativePath(args[args.indexOf("--request")+1]),grant=nativePath(args[args.indexOf("--output")+1]);
 const data=Buffer.from(JSON.stringify({descriptor:JSON.parse(fs.readFileSync(request)),token:${JSON.stringify(secret)}}));
 record({operation:"grant",args});
 if(mode==="symlink"){fs.writeFileSync(grant+".target",data);fs.symlinkSync(grant+".target",grant);}
 else fs.writeFileSync(grant,data,{flag:"wx",mode:384});
 if(mode==="error"){console.error(${JSON.stringify(secret)});process.exit(17);}
 if(mode==="overflow"){console.log(${JSON.stringify(secret)}.repeat(20));return;}
 console.log(JSON.stringify({ok:true,operation:"grant"}));return;
}
if(args[2]==="-c"){
 record({operation:"verify"});const data=fs.readFileSync(nativePath(args[4]));
 console.log(mode==="mismatch"?"0".repeat(64):digest(data));return;
}
process.exit(19);
});`,
    { mode: 0o700 },
  );
  const options = {
    nativePython: "C:\\runtime\\python.exe",
    mappedNativePython: executable,
    installedForkDirectory: "C:\\installed\\AutodeskFusionMCP",
    mappedInstalledForkDirectory: directory,
    provisionPath: "C:\\private\\provision.json",
    localAppData: "C:\\Users\\operator\\AppData\\Local",
    nativePrivateDirectory: "C:\\private\\grants",
    mappedPrivateDirectory: mapped,
    linuxGrantDirectory: linux,
  };
  return {
    directory,
    mapped,
    linux,
    secret,
    options,
    records: () =>
      fs.existsSync(trace)
        ? fs
            .readFileSync(trace, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>)
        : [],
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

test(
  "private native CLI preserves descriptor and publishes byte-exact Linux 0600 copy",
  platformOptions,
  async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const mutable = structuredClone(descriptor);
    const port = createNativePhysicalGenerationProvision(f.options);
    const pending = port.provision(mutable);
    mutable.brokerOwner.queueDirectory = "/incorrect-later-mutation";
    const result = await pending;
    const raw = fs.readFileSync(result.grantFile);
    const data = JSON.parse(raw.toString()) as {
      descriptor: PhysicalGenerationDescriptor;
      token: string;
    };
    assert.deepEqual(data.descriptor, descriptor);
    assert.equal(data.token, f.secret);
    assert.equal(
      result.grantDigest,
      createHash("sha256").update(raw).digest("hex"),
    );
    assert.equal(fs.statSync(result.grantFile).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(result).sort(), ["grantDigest", "grantFile"]);
    const records = f.records();
    assert.deepEqual(
      records.map((r) => r["operation"]),
      ["prepare", "grant", "verify"],
    );
    assert.deepEqual(records[0]?.["descriptor"], descriptor);
    const env = records[0]?.["env"] as Record<string, string>;
    assert.equal(
      env["FUSION_MCP_ADMISSION_PROVISION"],
      f.options.provisionPath,
    );
    assert.equal(env["LOCALAPPDATA"], f.options.localAppData);
    assert.equal(
      env["WSLENV"],
      "SystemRoot:LOCALAPPDATA:FUSION_MCP_ADMISSION_PROVISION",
    );
    assert.equal(env["HOME"], undefined);
    const attempts = fs.readdirSync(f.mapped);
    const nativeRaw = fs.readFileSync(
      path.join(f.mapped, attempts[0]!, "grant.json"),
    );
    assert.deepEqual(nativeRaw, raw);
    assert.equal(
      fs.readFileSync(
        path.join(f.mapped, attempts[0]!, "request.json"),
        "utf8",
      ),
      JSON.stringify(descriptor),
    );
    await assert.rejects(
      port.provision(descriptor),
      (error: unknown) =>
        error instanceof PhysicalGenerationProvisionError &&
        error.grantIssuance === "unknown",
    );
    assert.equal(f.records().length, 3);
  },
);

for (const mode of ["error", "overflow", "mismatch", "symlink"]) {
  test(
    `native ${mode} leaves uncertain issuance and private evidence without retry`,
    platformOptions,
    async (t) => {
      const f = fixture(mode);
      t.after(f.cleanup);
      const port = createNativePhysicalGenerationProvision(f.options);
      await assert.rejects(port.provision(descriptor), (error: unknown) => {
        assert.ok(error instanceof PhysicalGenerationProvisionError);
        assert.equal(error.grantIssuance, "unknown");
        assert.equal(String(error).includes(f.secret), false);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(fs.readdirSync(f.linux).length, 0);
      const attempt = fs.readdirSync(f.mapped)[0]!;
      assert.equal(
        fs.existsSync(path.join(f.mapped, attempt, "grant.json")),
        true,
      );
      assert.equal(
        f.records().filter((r) => r["operation"] === "grant").length,
        1,
      );
      await assert.rejects(port.provision(descriptor));
      assert.equal(
        f.records().filter((r) => r["operation"] === "grant").length,
        1,
      );
    },
  );
}

test(
  "public Linux destination is refused before issuing a grant",
  platformOptions,
  async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    fs.chmodSync(f.linux, 0o755);
    const port = createNativePhysicalGenerationProvision(f.options);
    await assert.rejects(
      port.provision(descriptor),
      (error: unknown) =>
        error instanceof PhysicalGenerationProvisionError &&
        error.grantIssuance === "notStarted",
    );
    assert.equal(f.records().length, 0);
  },
);

test(
  "symlink Linux destination is refused without native calls",
  platformOptions,
  async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const link = path.join(f.directory, "linux-link");
    fs.symlinkSync(f.linux, link);
    const port = createNativePhysicalGenerationProvision({
      ...f.options,
      linuxGrantDirectory: link,
    });
    await assert.rejects(port.provision(descriptor));
    assert.equal(f.records().length, 0);
  },
);

test(
  "invalid pins and timeout are rejected before invoking native Python",
  platformOptions,
  (t) => {
    const f = fixture();
    t.after(f.cleanup);
    for (const options of [
      { ...f.options, nativePython: "python.exe" },
      { ...f.options, installedForkDirectory: "\\\\server\\share" },
      { ...f.options, mappedPrivateDirectory: "relative" },
      { ...f.options, timeoutMs: Number.NaN },
    ])
      assert.throws(
        () => createNativePhysicalGenerationProvision(options),
        PhysicalGenerationProvisionError,
      );
    assert.equal(f.records().length, 0);
  },
);
