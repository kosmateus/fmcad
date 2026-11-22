import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
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
  fs.mkdirSync(path.join(directory, "lib"));
  const installedPackageFiles: Record<string, string> = {};
  for (const name of [
    "lib/physical_authority.py",
    "lib/physical_lifecycle.py",
  ]) {
    const raw = Buffer.from("# fake offline CLI source");
    fs.writeFileSync(path.join(directory, name), raw);
    installedPackageFiles[name] = createHash("sha256")
      .update(raw)
      .digest("hex");
  }
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
const inputRaw=Buffer.concat(input),parsed=inputRaw.length?JSON.parse(inputRaw):null;
const legacy=args[2]==="-m"?"grant":args[3]?.includes("root=Path")?"prepare":"verify";
const envelope=parsed?.action?parsed:{action:legacy,
 attempt:args[5],descriptorRaw:inputRaw.toString(),
 request:args[args.indexOf("--request")+1],output:legacy==="verify"?args[4]:args[args.indexOf("--output")+1],
 descriptor:legacy==="grant"?JSON.parse(fs.readFileSync(nativePath(args[args.indexOf("--request")+1]))):parsed};
const raw=Buffer.from(envelope.descriptorRaw||"");
if(envelope.action==="prepare"){
 const attempt=envelope.attempt,dir=path.join(root,attempt);fs.mkdirSync(dir,{mode:448});
 fs.writeFileSync(path.join(dir,"request.json"),raw,{flag:"wx",mode:384});
 if(envelope.activationRaw!==undefined)fs.writeFileSync(path.join(dir,"activation.json"),envelope.activationRaw,{flag:"wx",mode:384});
 record({operation:"prepare",descriptor:JSON.parse(raw),activationRaw:envelope.activationRaw,cwd:process.cwd(),env:process.env,startupFlags:args.slice(0,4),bootstrap:args[4]});
 if(mode==="changed-fork")fs.writeFileSync(${JSON.stringify(path.join(directory, "lib/physical_lifecycle.py"))},"# changed");
 if(mode==="owner-lost")fs.writeFileSync(${JSON.stringify(path.join(directory, "owner-lost"))},"during-native-prepare");
 console.log(digest(raw));return;
}
if(envelope.action==="grant"){
 const request=nativePath(envelope.request),grant=nativePath(envelope.output);
 const data=Buffer.from(JSON.stringify({descriptor:JSON.parse(fs.readFileSync(request)),token:${JSON.stringify(secret)}}));
 record({operation:"grant",args,activationRaw:envelope.activationRaw});
 if(mode==="symlink"){fs.writeFileSync(grant+".target",data);fs.symlinkSync(grant+".target",grant);}
 else fs.writeFileSync(grant,data,{flag:"wx",mode:384});
 if(mode==="owner-lost-at-grant")fs.writeFileSync(${JSON.stringify(path.join(directory, "owner-lost"))},"after-grant-started");
 if(mode==="error"){console.error(${JSON.stringify(secret)});process.exit(17);}
 if(mode==="overflow"){console.log(${JSON.stringify(secret)}.repeat(300));return;}
 if(mode==="foreign-ack"){console.log(JSON.stringify({state:"granted",handoffId:"foreign"}));return;}
 if(mode==="malformed-ack"){console.log("{broken");return;}
 if(mode==="pending-ack"){console.log(JSON.stringify({state:"pending",handoffId:envelope.descriptor.handoffId}));return;}
 if(mode==="duplicate-ack"){console.log('{"state":"unknown","state":"granted","handoffId":'+JSON.stringify(envelope.descriptor.handoffId)+'}');return;}
 if(mode==="invalid-utf8-ack"){process.stdout.write(Buffer.concat([Buffer.from('{"state":"granted","handoffId":"'),Buffer.from([255]),Buffer.from('"}')]));return;}
 console.log(JSON.stringify({state:"granted",handoffId:envelope.descriptor.handoffId}));return;
}
if(envelope.action==="verify"){
 record({operation:"verify"});const data=fs.readFileSync(nativePath(envelope.output));
 console.log(mode==="mismatch"?"0".repeat(64):digest(data));return;
}
process.exit(19);
});`,
    { mode: 0o700 },
  );
  const options = {
    nativePython: "C:\\runtime\\python.exe",
    mappedNativePython: executable,
    nativePythonSha256: createHash("sha256")
      .update(fs.readFileSync(executable))
      .digest("hex"),
    installedForkDirectory: "C:\\installed\\AutodeskFusionMCP",
    mappedInstalledForkDirectory: directory,
    installedPackageFiles,
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
    assert.deepEqual(records[0]?.["startupFlags"], ["-I", "-S", "-B", "-c"]);
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

for (const mode of [
  "error",
  "overflow",
  "mismatch",
  "symlink",
  "foreign-ack",
  "malformed-ack",
  "pending-ack",
  "duplicate-ack",
]) {
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
  "exact bootstrap from the actual spawn arguments compiles in Python",
  platformOptions,
  async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    await createNativePhysicalGenerationProvision(f.options).provision(
      descriptor,
    );
    const bootstrap = f.records()[0]?.["bootstrap"];
    assert.equal(typeof bootstrap, "string");
    const compiled = spawnSync(
      "python3",
      [
        "-I",
        "-S",
        "-B",
        "-c",
        "import json,sys; compile(json.load(sys.stdin),'actual-spawn-bootstrap','exec')",
      ],
      {
        input: JSON.stringify(bootstrap),
        encoding: "utf8",
      },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
  },
);

test(
  "stable symlink in the Linux parent chain refuses with zero native process calls",
  platformOptions,
  async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const parentAlias = path.join(f.directory, "parent-alias");
    fs.symlinkSync(f.directory, parentAlias);
    const port = createNativePhysicalGenerationProvision({
      ...f.options,
      linuxGrantDirectory: path.join(parentAlias, "linux"),
    });
    await assert.rejects(port.provision(descriptor));
    assert.equal(f.records().length, 0);
  },
);

test(
  "invalid UTF-8 acknowledgment cannot alias a replacement-character handoff",
  platformOptions,
  async (t) => {
    const f = fixture("invalid-utf8-ack");
    t.after(f.cleanup);
    const request = structuredClone(descriptor);
    request.handoffId = "\ufffd";
    const port = createNativePhysicalGenerationProvision(f.options);
    await assert.rejects(
      port.provision(request),
      (error: unknown) =>
        error instanceof PhysicalGenerationProvisionError &&
        error.grantIssuance === "unknown",
    );
    assert.equal(fs.readdirSync(f.linux).length, 0);
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

test(
  "wrong executable or fork mapping refuses before launching untrusted code",
  platformOptions,
  async (t) => {
    for (const target of ["executable", "fork"]) {
      const f = fixture();
      t.after(f.cleanup);
      const port = createNativePhysicalGenerationProvision(f.options);
      fs.appendFileSync(
        target === "executable"
          ? f.options.mappedNativePython
          : path.join(f.directory, "lib/physical_lifecycle.py"),
        "\n# changed untrusted source",
      );
      await assert.rejects(port.provision(descriptor));
      assert.equal(f.records().length, 0);
      assert.equal(fs.readdirSync(f.linux).length, 0);
    }
  },
);

test(
  "package is pinned again before the grant process, not only during preparation",
  platformOptions,
  async (t) => {
    const f = fixture("changed-fork");
    t.after(f.cleanup);
    const port = createNativePhysicalGenerationProvision(f.options);
    await assert.rejects(port.provision(descriptor));
    assert.deepEqual(
      f.records().map((r) => r["operation"]),
      ["prepare"],
    );
    assert.equal(fs.readdirSync(f.linux).length, 0);
  },
);

test(
  "parent rename and public symlink cannot redirect a token write",
  platformOptions,
  async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const open = fs.openSync;
    let replaced = false;
    t.mock.method(
      fs,
      "openSync",
      (file: fs.PathLike, flags: number | string, mode?: fs.Mode) => {
        if (
          !replaced &&
          String(file).endsWith(".grant.json") &&
          typeof flags === "number" &&
          (flags & fs.constants.O_CREAT) !== 0
        ) {
          replaced = true;
          fs.renameSync(f.linux, f.linux + "-original");
          fs.mkdirSync(f.linux + "-public", { mode: 0o777 });
          fs.symlinkSync(f.linux + "-public", f.linux);
        }
        return open(file, flags, mode);
      },
    );
    const port = createNativePhysicalGenerationProvision(f.options);
    await assert.rejects(
      port.provision(descriptor),
      (error: unknown) =>
        error instanceof PhysicalGenerationProvisionError &&
        error.grantIssuance === "unknown",
    );
    assert.deepEqual(fs.readdirSync(f.linux + "-public"), []);
    const privateOriginal = f.linux + "-original";
    assert.equal(fs.statSync(privateOriginal).mode & 0o777, 0o700);
    const retained = fs.readdirSync(privateOriginal);
    assert.equal(retained.length, 1);
    const copy = path.join(privateOriginal, retained[0]!);
    assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(copy, "utf8")).token, f.secret);
  },
);

const activation = {
  requestId: "approved-rebaseline",
  fenceNonce: "c".repeat(64),
  newHead: "a".repeat(64),
  publicationDigest: "b".repeat(64),
  receiptDigest: "d".repeat(64),
};

test(
  "owner loss during native preparation refuses before issuing any grant",
  platformOptions,
  async () => {
    const f = fixture("owner-lost");
    try {
      const port = createNativePhysicalGenerationProvision({
        ...f.options,
        assertBrokerOwner() {
          if (fs.existsSync(path.join(f.directory, "owner-lost")))
            throw new Error("Owned broker fixture no longer owns the queue");
        },
      });
      await assert.rejects(
        port.provision(descriptor),
        (error: unknown) =>
          error instanceof PhysicalGenerationProvisionError &&
          error.grantIssuance === "notStarted",
      );
      assert.deepEqual(
        f.records().map((record) => record["operation"]),
        ["prepare"],
      );
      assert.equal(fs.readdirSync(f.linux).length, 0);
    } finally {
      f.cleanup();
    }
  },
);

test(
  "missing owner initially or after activation lookup refuses without a native process",
  platformOptions,
  async () => {
    for (const phase of ["initial", "activation"]) {
      const f = fixture();
      try {
        let held = phase !== "initial";
        const port = createNativePhysicalGenerationProvision({
          ...f.options,
          assertBrokerOwner() {
            if (!held)
              throw new Error("Owned fixture lost its actual broker owner");
          },
          async getVerifiedActivation() {
            held = false;
            return activation;
          },
        });
        await assert.rejects(
          port.provision(descriptor),
          (error: unknown) =>
            error instanceof PhysicalGenerationProvisionError &&
            error.grantIssuance === "notStarted",
        );
        assert.equal(f.records().length, 0);
      } finally {
        f.cleanup();
      }
    }
  },
);

test(
  "owner loss after grant spawn remains UNKNOWN and preserves private issuance evidence",
  platformOptions,
  async () => {
    const f = fixture("owner-lost-at-grant");
    try {
      const port = createNativePhysicalGenerationProvision({
        ...f.options,
        assertBrokerOwner() {
          if (fs.existsSync(path.join(f.directory, "owner-lost")))
            throw new Error("Owned fixture lost its actual broker owner");
        },
      });
      await assert.rejects(
        port.provision(descriptor),
        (error: unknown) =>
          error instanceof PhysicalGenerationProvisionError &&
          error.grantIssuance === "unknown",
      );
      assert.deepEqual(
        f.records().map((record) => record["operation"]),
        ["prepare", "grant"],
      );
      const attempt = fs.readdirSync(f.mapped)[0]!;
      assert.ok(fs.existsSync(path.join(f.mapped, attempt, "grant.json")));
      assert.equal(fs.readdirSync(f.linux).length, 0);
    } finally {
      f.cleanup();
    }
  },
);

test(
  "trusted native approval reaches the private grant channel without changing the public descriptor",
  platformOptions,
  async () => {
    const f = fixture();
    try {
      let reads = 0;
      const port = createNativePhysicalGenerationProvision({
        ...f.options,
        async getVerifiedActivation(current) {
          reads++;
          assert.deepEqual(current, descriptor);
          current.brokerOwner.nonce = "cannot-mutate-the-issued-descriptor";
          return activation;
        },
      });
      const result = await port.provision(descriptor);
      assert.equal(reads, 1);
      const records = f.records();
      assert.equal(
        records.find((record) => record["operation"] === "prepare")?.[
          "activationRaw"
        ],
        JSON.stringify(activation),
      );
      assert.equal(
        records.find((record) => record["operation"] === "grant")?.[
          "activationRaw"
        ],
        JSON.stringify(activation),
      );
      const grant = JSON.parse(fs.readFileSync(result.grantFile, "utf8"));
      assert.deepEqual(grant.descriptor, descriptor);
      assert.deepEqual(Object.keys(grant).sort(), ["descriptor", "token"]);
    } finally {
      f.cleanup();
    }
  },
);

test(
  "failed or malformed private activation refuses before any native issuance",
  platformOptions,
  async () => {
    for (const mode of ["unverified", "malformed"]) {
      const f = fixture();
      try {
        const port = createNativePhysicalGenerationProvision({
          ...f.options,
          async getVerifiedActivation() {
            if (mode === "unverified") throw new Error(f.secret);
            return { ...activation, receiptDigest: "not-a-native-receipt" };
          },
        });
        await assert.rejects(
          port.provision(descriptor),
          (error: unknown) =>
            error instanceof PhysicalGenerationProvisionError &&
            error.grantIssuance === "notStarted" &&
            !error.message.includes(f.secret),
        );
        assert.equal(f.records().length, 0);
      } finally {
        f.cleanup();
      }
    }
  },
);

const nativePython = process.env["FMCAD_TEST_NATIVE_PYTHON"];
const nativePythonWin = process.env["FMCAD_TEST_NATIVE_PYTHON_WIN"];
const nativeRoot = process.env["FMCAD_TEST_NATIVE_DIRECTORY"];
const nativeRootWin = process.env["FMCAD_TEST_NATIVE_DIRECTORY_WIN"];
const localAppData = process.env["FMCAD_TEST_NATIVE_LOCALAPPDATA"];
const nativePlatformOptions = {
  skip:
    process.platform !== "linux" ||
    !nativePython ||
    !nativePythonWin ||
    !nativeRoot ||
    !nativeRootWin ||
    !localAppData
      ? "Requires explicitly configured native Windows Python and owned filesystem fixture root; no Fusion calls"
      : false,
};

test(
  "actual native bootstrap positively reaches an owned offline issuer and copies its fake grant",
  nativePlatformOptions,
  async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const id = path.basename(f.directory);
    const root = path.join(nativeRoot!, id);
    const rootWin = path.win32.join(nativeRootWin!, id);
    const mailbox = root + "-mailbox";
    const mailboxWin = rootWin + "-mailbox";
    const events = root + "-events";
    const eventsWin = rootWin + "-events";
    const provisionFile = root + "-provision.json";
    const provisionWin = rootWin + "-provision.json";
    fs.mkdirSync(root, { mode: 0o700 });
    fs.mkdirSync(path.join(root, "lib"));
    t.after(() => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(mailbox, { recursive: true, force: true });
      fs.rmSync(events, { force: true });
      fs.rmSync(provisionFile, { force: true });
    });
    const files: Record<string, string> = {
      "lib/__init__.py": "",
      "lib/physical_authority.py": `
from pathlib import Path
def private_directory(value):
    value=Path(value)
    value.mkdir(parents=True,exist_ok=True,mode=0o700)
    return value
def _read_private_bytes(value):
    with open(${JSON.stringify(eventsWin)},"a") as f:
        f.write("owned-private-read\\n")
    return Path(value).read_bytes()
`,
      "lib/physical_lifecycle.py": `
import argparse,json,os
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument("operation",choices=["grant"])
p.add_argument("--request",required=True)
p.add_argument("--output",required=True)
p.add_argument("--timeout",required=True)
p.add_argument("--activation")
a=p.parse_args()
d=json.loads(Path(a.request).read_bytes())
if a.activation is not None:
    assert json.loads(Path(a.activation).read_bytes())==${JSON.stringify(activation)}
    try:
        with open(a.activation,"wb") as changed:
            raise RuntimeError("Private activation write was not fenced")
    except PermissionError:
        pass
    try:
        os.replace(a.activation,a.activation+".moved")
        raise RuntimeError("Private activation replacement was not fenced")
    except PermissionError:
        pass
    with open(${JSON.stringify(eventsWin)},"a") as f:
        f.write("owned-activation-held\\n")
raw=json.dumps({"descriptor":d,"token":"OWNED-FAKE-OFFLINE-NOT-A-REAL-GRANT"}).encode("utf-8")
fd=os.open(a.output,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,"wb") as f:
    f.write(raw)
    f.flush()
    os.fsync(f.fileno())
with open(${JSON.stringify(eventsWin)},"a") as f:
    f.write("owned-fake-issuer-reached\\n")
print(json.dumps({"state":"granted","handoffId":d["handoffId"]}))
`,
    };
    const packageFiles: Record<string, string> = {};
    for (const [name, source] of Object.entries(files)) {
      fs.writeFileSync(path.join(root, name), source);
      packageFiles[name] = createHash("sha256").update(source).digest("hex");
    }
    // This owned plain-Python process is the fixture's pinned physical identity.
    // It imports no Fusion code, opens no ports, and terminates when stdin closes.
    const issuer = spawn(
      nativePython!,
      [
        "-I",
        "-S",
        "-B",
        "-c",
        `
import ctypes,json,os,sys
from ctypes import wintypes as wt
k=ctypes.WinDLL("kernel32",use_last_error=True)
k.GetCurrentProcess.restype=wt.HANDLE
k.GetProcessTimes.argtypes=[wt.HANDLE,ctypes.POINTER(wt.FILETIME),ctypes.POINTER(wt.FILETIME),ctypes.POINTER(wt.FILETIME),ctypes.POINTER(wt.FILETIME)]
times=[wt.FILETIME() for _ in range(4)]
if not k.GetProcessTimes(k.GetCurrentProcess(),*(ctypes.byref(x) for x in times)):
    raise RuntimeError("Fixture birth unavailable")
print(json.dumps({"pid":os.getpid(),"birth":str((times[0].dwHighDateTime<<32)|times[0].dwLowDateTime)}),flush=True)
sys.stdin.buffer.read()
`,
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const exited = new Promise<void>((resolve) =>
      issuer.once("close", () => resolve()),
    );
    t.after(async () => {
      issuer.stdin.end();
      await exited;
    });
    const processBinding = await new Promise<{ pid: number; birth: string }>(
      (resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => {
          issuer.kill();
          reject(new Error("Owned native fixture startup timed out"));
        }, 10_000);
        issuer.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        issuer.stdout.on("data", (bytes: Buffer) => {
          output += bytes.toString("utf8");
          if (output.includes("\n")) {
            clearTimeout(timeout);
            try {
              resolve(JSON.parse(output.trim()));
            } catch (error) {
              reject(error);
            }
          }
        });
      },
    );
    const ownedDescriptor = structuredClone(descriptor);
    Object.assign(ownedDescriptor.physicalRuntime, processBinding);
    fs.writeFileSync(
      provisionFile,
      JSON.stringify({
        ...ownedDescriptor.physicalRuntime,
        instance: ownedDescriptor.generation.instance,
        epoch: ownedDescriptor.generation.epoch,
      }),
    );
    const nativeOptions = {
      ...f.options,
      nativePython: nativePythonWin!,
      mappedNativePython: nativePython!,
      nativePythonSha256: createHash("sha256")
        .update(fs.readFileSync(nativePython!))
        .digest("hex"),
      installedForkDirectory: rootWin,
      mappedInstalledForkDirectory: root,
      installedPackageFiles: packageFiles,
      provisionPath: provisionWin,
      localAppData: localAppData!,
      nativePrivateDirectory: mailboxWin,
      mappedPrivateDirectory: mailbox,
    };
    const port = createNativePhysicalGenerationProvision(nativeOptions);
    const result = await port.provision(ownedDescriptor);
    const raw = fs.readFileSync(result.grantFile);
    assert.equal(
      result.grantDigest,
      createHash("sha256").update(raw).digest("hex"),
    );
    assert.equal(fs.statSync(result.grantFile).mode & 0o777, 0o600);
    const data = JSON.parse(raw.toString());
    assert.deepEqual(data.descriptor, ownedDescriptor);
    assert.equal(data.token, "OWNED-FAKE-OFFLINE-NOT-A-REAL-GRANT");
    assert.deepEqual(fs.readFileSync(events, "utf8").trim().split(/\r?\n/), [
      "owned-private-read",
      "owned-fake-issuer-reached",
      "owned-private-read",
    ]);
    const attempt = fs.readdirSync(mailbox)[0]!;
    assert.equal(
      fs.readFileSync(path.join(mailbox, attempt, "request.json"), "utf8"),
      JSON.stringify(ownedDescriptor),
    );
    assert.deepEqual(
      fs.readFileSync(path.join(mailbox, attempt, "grant.json")),
      raw,
    );
    const activated = await createNativePhysicalGenerationProvision({
      ...nativeOptions,
      async getVerifiedActivation(current) {
        assert.deepEqual(current, ownedDescriptor);
        return activation;
      },
    }).provision(ownedDescriptor);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(activated.grantFile, "utf8")).descriptor,
      ownedDescriptor,
    );
    assert.ok(
      fs.readFileSync(events, "utf8").includes("owned-activation-held"),
    );
    const approvedAttempt = fs
      .readdirSync(mailbox)
      .find((name) =>
        fs.existsSync(path.join(mailbox, name, "activation.json")),
      );
    assert.ok(approvedAttempt);
    assert.equal(
      fs.readFileSync(
        path.join(mailbox, approvedAttempt, "activation.json"),
        "utf8",
      ),
      JSON.stringify(activation),
    );
  },
);

test(
  "real isolated Windows Python refuses shadow json/sitecustomize and wrong fork before imports",
  nativePlatformOptions,
  async (t) => {
    const f = fixture();
    t.after(f.cleanup);
    const id = path.basename(f.directory);
    const root = path.join(nativeRoot!, id);
    fs.mkdirSync(root, { mode: 0o700 });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, "lib"));
    const marker = path.join(root, "UNTRUSTED-IMPORT");
    const markerWin = path.win32.join(nativeRootWin!, id, "UNTRUSTED-IMPORT");
    const attack = `open(${JSON.stringify(markerWin)}, "w").write("UNTRUSTED")\nraise RuntimeError("must not import")\n`;
    const packageFiles: Record<string, string> = {};
    for (const name of [
      "lib/physical_authority.py",
      "lib/physical_lifecycle.py",
    ]) {
      fs.writeFileSync(path.join(root, name), attack);
      packageFiles[name] = createHash("sha256").update(attack).digest("hex");
    }
    for (const name of ["json.py", "sitecustomize.py"])
      fs.writeFileSync(path.join(root, name), attack);
    const nativeOptions = {
      ...f.options,
      nativePython: nativePythonWin!,
      mappedNativePython: nativePython!,
      nativePythonSha256: createHash("sha256")
        .update(fs.readFileSync(nativePython!))
        .digest("hex"),
      installedForkDirectory: path.win32.join(nativeRootWin!, id),
      mappedInstalledForkDirectory: root,
      installedPackageFiles: packageFiles,
      localAppData: localAppData!,
    };
    const port = createNativePhysicalGenerationProvision(nativeOptions);
    await assert.rejects(
      port.provision(descriptor),
      (error: unknown) =>
        error instanceof PhysicalGenerationProvisionError &&
        error.guardCode === "NATIVE_PACKAGE_CONTENTS",
    );
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.readdirSync(f.linux).length, 0);
    for (const name of ["json.py", "sitecustomize.py"])
      fs.unlinkSync(path.join(root, name));
    const wrongCwd = createNativePhysicalGenerationProvision({
      ...nativeOptions,
      installedForkDirectory: path.win32.join(nativeRootWin!, id + "-wrong"),
    });
    await assert.rejects(
      wrongCwd.provision(descriptor),
      (error: unknown) =>
        error instanceof PhysicalGenerationProvisionError &&
        error.guardCode === "NATIVE_RUNTIME_MAPPING",
    );
    assert.equal(fs.existsSync(marker), false);
    const provisionFile = path.join(nativeRoot!, id + "-provision.json");
    const invalidProcess = structuredClone(descriptor);
    invalidProcess.physicalRuntime.pid = 0;
    fs.writeFileSync(
      provisionFile,
      JSON.stringify({
        ...invalidProcess.physicalRuntime,
        instance: invalidProcess.generation.instance,
        epoch: invalidProcess.generation.epoch,
      }),
    );
    t.after(() => fs.unlinkSync(provisionFile));
    const wrongProcess = createNativePhysicalGenerationProvision({
      ...nativeOptions,
      provisionPath: path.win32.join(nativeRootWin!, id + "-provision.json"),
    });
    await assert.rejects(
      wrongProcess.provision(invalidProcess),
      (error: unknown) =>
        error instanceof PhysicalGenerationProvisionError &&
        error.guardCode === "NATIVE_PROCESS_UNAVAILABLE",
    );
    assert.equal(fs.existsSync(marker), false);
  },
);
