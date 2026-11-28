import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  initializeRuntimeVerificationRealm,
  readRuntimeVerificationRealm,
} from "../packages/node-adapters/src/execution/runtime-verification-realm";

const moduleFile =
  require.resolve("../packages/node-adapters/src/execution/runtime-verification-realm");
const execute = promisify(execFile);
const hash = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-realm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    realm: path.join(root, "runtime-verification"),
    key: path.join(root, "runtime-verification/verification.key"),
    metadata: path.join(root, "runtime-verification/realm.json"),
  };
}
const program = `
  const fs=require('node:fs'),crypto=require('node:crypto');
  const [moduleFile,store,action,hook]=process.argv.slice(1);
  if(hook) eval(hook);
  const api=require(moduleFile);
  try {
    const result=api[action==='init'?'initializeRuntimeVerificationRealm':'readRuntimeVerificationRealm'](store);
    console.log(JSON.stringify({result}));
  } catch(error) {
    console.log(JSON.stringify({error:{code:error.code,message:error.message,stack:error.stack}}));
  }
`;
function child(root: string, action: "init" | "read", hook = "") {
  const result = spawnSync(
    process.execPath,
    ["-e", program, moduleFile, root, action, hook],
    { encoding: "utf8", timeout: 3000 },
  );
  assert.equal(
    result.error,
    undefined,
    "child must not block on special files",
  );
  return result;
}
function snapshot(files: string[]) {
  return files.map((file) => {
    const stat = fs.statSync(file);
    return {
      digest: hash(fs.readFileSync(file)),
      ino: stat.ino,
      mtime: stat.mtimeMs,
      ctime: stat.ctimeMs,
      mode: stat.mode,
      nlink: stat.nlink,
    };
  });
}

test("explicit init and fresh-process read preserve the exact private key and stable identity", (t) => {
  const f = fixture(t);
  const result = initializeRuntimeVerificationRealm(f.root);
  const key = fs.readFileSync(f.key);
  const digest = hash(key);
  assert.equal(key.length, 32);
  assert.deepEqual(result, {
    keyId: `fmcad-rebaseline-${digest}`,
    keyReference: { path: f.key, sha256: digest },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.metadata, "utf8")), {
    kind: "fmcad-runtime-verification-realm",
    version: 1,
    keyId: result.keyId,
    sha256: digest,
  });
  assert.equal(fs.statSync(f.realm).mode & 0o7777, 0o700);
  assert.equal(fs.statSync(f.key).mode & 0o7777, 0o600);
  assert.equal(fs.statSync(f.metadata).mode & 0o7777, 0o600);
  const before = snapshot([f.key, f.metadata]);
  assert.deepEqual(readRuntimeVerificationRealm(f.root), result);
  assert.deepEqual(initializeRuntimeVerificationRealm(f.root), result);
  assert.deepEqual(JSON.parse(child(f.root, "read").stdout).result, result);
  assert.deepEqual(snapshot([f.key, f.metadata]), before);
});

test("read missing realm performs no writes or creation", (t) => {
  const f = fixture(t);
  const result = child(
    f.root,
    "read",
    `
    for(const name of ['mkdirSync','writeFileSync','renameSync','unlinkSync','linkSync'])
      fs[name]=()=>{throw new Error('UNEXPECTED_WRITE')};
  `,
  );
  assert.equal(
    JSON.parse(result.stdout).error.code,
    "RUNTIME_VERIFICATION_REALM_MISSING",
  );
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test("successful read and repeated init do not generate a replacement key", (t) => {
  const f = fixture(t);
  const expected = initializeRuntimeVerificationRealm(f.root);
  const hook = `
    crypto.randomBytes=()=>{throw new Error('UNEXPECTED_RANDOM')};
    for(const name of ['writeFileSync','renameSync','unlinkSync','linkSync'])
      fs[name]=()=>{throw new Error('UNEXPECTED_CONTENT_WRITE')};
  `;
  for (const action of ["read", "init"] as const)
    assert.deepEqual(
      JSON.parse(child(f.root, action, hook).stdout).result,
      expected,
    );
});

test("existing read opens only readonly FDs and never creates even when partial", (t) => {
  const f = fixture(t);
  initializeRuntimeVerificationRealm(f.root);
  const hook = `
    const original=fs.openSync;
    fs.openSync=(file,flags,...rest)=>{
      if(typeof flags!=='number'||(flags&(fs.constants.O_CREAT|fs.constants.O_WRONLY|fs.constants.O_RDWR)))
        throw new Error('WRITABLE_OPEN');
      return original(file,flags,...rest);
    };
    for(const name of ['mkdirSync','writeFileSync','renameSync','unlinkSync','linkSync'])
      fs[name]=()=>{throw new Error('CONTENT_WRITE')};
  `;
  assert.ok(JSON.parse(child(f.root, "read", hook).stdout).result);
  fs.unlinkSync(f.metadata);
  assert.equal(
    JSON.parse(child(f.root, "read", hook).stdout).error.code,
    "RUNTIME_VERIFICATION_REALM_INCOMPLETE",
  );
  assert.equal(fs.existsSync(f.metadata), false);
});

for (const boundary of ["key-before-fsync", "before-metadata"] as const) {
  test(`explicit init completes ${boundary} crash without rotating key`, (t) => {
    const f = fixture(t);
    const hook =
      boundary === "key-before-fsync"
        ? `
      const original=fs.fsyncSync;
      fs.fsyncSync=fd=>{
        if(fs.realpathSync('/proc/self/fd/'+fd).endsWith('/verification.key')) process.exit(91);
        return original(fd);
      };
    `
        : `
      const original=fs.openSync;
      fs.openSync=(file,flags,...rest)=>{
        if(String(file).endsWith('/realm.json')&&(flags&fs.constants.O_CREAT)) process.exit(91);
        return original(file,flags,...rest);
      };
    `;
    assert.equal(child(f.root, "init", hook).status, 91);
    const before = snapshot([f.key]);
    assert.equal(fs.existsSync(f.metadata), false);
    assert.throws(() => readRuntimeVerificationRealm(f.root), {
      code: "RUNTIME_VERIFICATION_REALM_INCOMPLETE",
    });
    const result = initializeRuntimeVerificationRealm(f.root);
    assert.deepEqual(snapshot([f.key]), before);
    assert.equal(result.keyReference.sha256, before[0]!.digest);
    assert.deepEqual(readRuntimeVerificationRealm(f.root), result);
  });
}

for (const file of ["verification.key", "realm.json"] as const) {
  test(`crash during ${file} write refuses partial state without rotation or repair`, (t) => {
    const f = fixture(t);
    const result = child(
      f.root,
      "init",
      `
      const original=fs.writeFileSync;
      fs.writeFileSync=(fd,bytes,...rest)=>{
        if(typeof fd==='number'&&fs.realpathSync('/proc/self/fd/'+fd).endsWith('/${file}')){
          original(fd,bytes.subarray(0,3)); process.exit(92);
        }
        return original(fd,bytes,...rest);
      };
    `,
    );
    assert.equal(result.status, 92);
    const names = fs.readdirSync(f.realm);
    const files = names.map((name) => path.join(f.realm, name));
    const before = snapshot(files);
    assert.throws(() => readRuntimeVerificationRealm(f.root), {
      code: "RUNTIME_VERIFICATION_REALM_INCOMPLETE",
    });
    assert.throws(() => initializeRuntimeVerificationRealm(f.root), {
      code: "RUNTIME_VERIFICATION_REALM_INCOMPLETE",
    });
    assert.deepEqual(snapshot(files), before);
    assert.deepEqual(fs.readdirSync(f.realm), names);
  });
}

test("metadata without a key never causes key generation", (t) => {
  const f = fixture(t);
  initializeRuntimeVerificationRealm(f.root);
  fs.unlinkSync(f.key);
  const before = snapshot([f.metadata]);
  assert.throws(() => initializeRuntimeVerificationRealm(f.root), {
    code: "RUNTIME_VERIFICATION_REALM_INCOMPLETE",
  });
  assert.equal(fs.existsSync(f.key), false);
  assert.deepEqual(snapshot([f.metadata]), before);
});

for (const kind of ["mode", "symlink", "hardlink", "fifo"] as const) {
  for (const name of ["key", "metadata"] as const) {
    test(`unsafe ${kind} ${name} refuses read and init without touching entries`, (t) => {
      const f = fixture(t);
      initializeRuntimeVerificationRealm(f.root);
      const file = f[name];
      if (kind === "mode") fs.chmodSync(file, 0o640);
      else {
        fs.renameSync(file, file + ".original");
        if (kind === "symlink") fs.symlinkSync(file + ".original", file);
        if (kind === "hardlink") fs.linkSync(file + ".original", file);
        if (kind === "fifo") execFileSync("mkfifo", ["-m", "600", file]);
      }
      const names = fs.readdirSync(f.realm);
      const before = fs.lstatSync(file);
      for (const action of ["read", "init"] as const) {
        const result = JSON.parse(child(f.root, action).stdout);
        assert.equal(result.error.code, "RUNTIME_VERIFICATION_REALM_UNSAFE");
      }
      const after = fs.lstatSync(file);
      assert.deepEqual(
        [after.ino, after.mode, after.nlink, after.size],
        [before.ino, before.mode, before.nlink, before.size],
      );
      assert.deepEqual(fs.readdirSync(f.realm), names);
    });
  }
}

test("foreign owner, public directory and indirect store/realm are refused", (t) => {
  const f = fixture(t);
  initializeRuntimeVerificationRealm(f.root);
  const foreign = child(
    f.root,
    "read",
    `process.getuid=()=>${process.getuid!() + 1};`,
  );
  assert.equal(
    JSON.parse(foreign.stdout).error.code,
    "RUNTIME_VERIFICATION_REALM_UNSAFE",
  );
  fs.chmodSync(f.realm, 0o750);
  assert.throws(() => readRuntimeVerificationRealm(f.root), {
    code: "RUNTIME_VERIFICATION_REALM_UNSAFE",
  });
  fs.chmodSync(f.realm, 0o700);
  fs.renameSync(f.realm, f.realm + ".original");
  fs.symlinkSync(f.realm + ".original", f.realm);
  assert.throws(() => initializeRuntimeVerificationRealm(f.root), {
    code: "RUNTIME_VERIFICATION_REALM_UNSAFE",
  });
  const link = f.root + ".link";
  t.after(() => fs.unlinkSync(link));
  fs.symlinkSync(f.root, link);
  assert.throws(() => readRuntimeVerificationRealm(link), {
    code: "RUNTIME_VERIFICATION_REALM_UNSAFE",
  });
});

test("malformed metadata and injected IO errors never disclose secret bytes", (t) => {
  const f = fixture(t);
  initializeRuntimeVerificationRealm(f.root);
  const key = fs.readFileSync(f.key);
  const hexadecimal = key.toString("hex"),
    base64 = key.toString("base64");
  fs.writeFileSync(f.metadata, Buffer.concat([Buffer.from('{"bad":"'), key]));
  for (const action of ["read", "init"] as const) {
    const output = child(f.root, action).stdout;
    assert.equal(output.includes(hexadecimal), false);
    assert.equal(output.includes(base64), false);
    assert.equal(output.includes(key.toString("utf8")), false);
    assert.equal(
      JSON.parse(output).error.code,
      "RUNTIME_VERIFICATION_REALM_INCOMPLETE",
    );
  }
  const io = child(
    f.root,
    "read",
    `
    fs.readSync=()=>{throw new Error(fs.readFileSync(store+'/runtime-verification/verification.key').toString('hex'))};
  `,
  ).stdout;
  assert.equal(io.includes(hexadecimal), false);
  assert.equal(
    JSON.parse(io).error.code,
    "RUNTIME_VERIFICATION_REALM_UNAVAILABLE",
  );
});

test("root fsync failure returns no reference; explicit init can finish the same key", (t) => {
  const f = fixture(t);
  const result = child(
    f.root,
    "init",
    `
    const original=fs.fsyncSync;
    fs.fsyncSync=fd=>{
      if(fs.realpathSync('/proc/self/fd/'+fd)===store) throw new Error('root durability failure');
      return original(fd);
    };
  `,
  );
  assert.equal(
    JSON.parse(result.stdout).error.code,
    "RUNTIME_VERIFICATION_REALM_UNAVAILABLE",
  );
  const digest = hash(fs.readFileSync(f.key));
  assert.equal(
    initializeRuntimeVerificationRealm(f.root).keyReference.sha256,
    digest,
  );
});

test("read reasserts file and both directory fsyncs before returning; errors fail closed", (t) => {
  const f = fixture(t);
  initializeRuntimeVerificationRealm(f.root);
  const before = snapshot([f.key, f.metadata]);
  for (const target of [f.key, f.metadata, f.realm, f.root]) {
    const output = child(
      f.root,
      "read",
      `
      const original=fs.fsyncSync;
      fs.fsyncSync=fd=>{
        if(fs.realpathSync('/proc/self/fd/'+fd)===${JSON.stringify(target)}) throw new Error('fsync failed');
        return original(fd);
      };
    `,
    ).stdout;
    assert.equal(
      JSON.parse(output).error.code,
      "RUNTIME_VERIFICATION_REALM_UNAVAILABLE",
    );
  }
  assert.deepEqual(snapshot([f.key, f.metadata]), before);
});

test("concurrent independent initializer processes converge without rotating existing key", async (t) => {
  const f = fixture(t);
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      execute(process.execPath, [
        "-e",
        program,
        moduleFile,
        f.root,
        "init",
        "",
      ]),
    ),
  );
  const successful = results
    .map((r) => JSON.parse(r.stdout))
    .filter((r) => r.result);
  assert.ok(successful.length > 0);
  const final = initializeRuntimeVerificationRealm(f.root);
  for (const result of successful) assert.deepEqual(result.result, final);
  assert.deepEqual(readRuntimeVerificationRealm(f.root), final);
  assert.deepEqual(fs.readdirSync(f.realm).sort(), [
    "realm.json",
    "verification.key",
  ]);
});

test(
  "reader independently fsyncs complete concurrent bytes while writer is paused before metadata fsync",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t);
    const hook = `
      const original=fs.fsyncSync;
      fs.fsyncSync=fd=>{
        if(fs.realpathSync('/proc/self/fd/'+fd).endsWith('/realm.json')){
          process.send({paused:true}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
        }
        return original(fd);
      };
    `;
    const writer = spawn(
      process.execPath,
      ["-e", program, moduleFile, f.root, "init", hook],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    t.after(() => writer.kill("SIGKILL"));
    await new Promise<void>((resolve, reject) => {
      writer.once("message", () => resolve());
      writer.once("error", reject);
      writer.once("exit", () =>
        reject(new Error("writer exited before boundary")),
      );
    });
    const output = child(
      f.root,
      "read",
      `
      const original=fs.fsyncSync,synced=[];
      fs.fsyncSync=fd=>{
        original(fd); synced.push(fs.realpathSync('/proc/self/fd/'+fd));
      };
      process.on('exit',()=>console.log(JSON.stringify({synced})));
    `,
    )
      .stdout.trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(output[0].result);
    assert.deepEqual(output[1].synced, [f.key, f.metadata, f.realm, f.root]);
    writer.kill("SIGKILL");
    await new Promise<void>((resolve) => writer.once("exit", () => resolve()));
    assert.deepEqual(readRuntimeVerificationRealm(f.root), output[0].result);
  },
);

test("FD source substitution is rejected before bytes are read", (t) => {
  const f = fixture(t);
  initializeRuntimeVerificationRealm(f.root);
  const result = child(
    f.root,
    "read",
    `
    const original=fs.openSync,read=fs.readSync;
    let replaced=false,reads=0;
    fs.openSync=(file,flags,...rest)=>{
      if(String(file).endsWith('/verification.key')&&!replaced){
        replaced=true;
        fs.renameSync(store+'/runtime-verification/verification.key',store+'/runtime-verification/original.key');
        fs.copyFileSync(store+'/runtime-verification/original.key',store+'/runtime-verification/verification.key');
      }
      return original(file,flags,...rest);
    };
    fs.readSync=(...args)=>{reads++;return read(...args)};
    process.on('exit',()=>console.log(JSON.stringify({reads})));
  `,
  )
    .stdout.trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(result[0].error.code, "RUNTIME_VERIFICATION_REALM_UNSAFE");
  assert.equal(result[1].reads, 0);
});

test("named key replacement during owned FD write is not overwritten or deleted", (t) => {
  const f = fixture(t);
  const output = child(
    f.root,
    "init",
    `
    const original=fs.writeFileSync;
    let replaced=false;
    fs.writeFileSync=(fd,bytes,...rest)=>{
      if(typeof fd==='number'&&!replaced&&fs.realpathSync('/proc/self/fd/'+fd).endsWith('/verification.key')){
        replaced=true;
        fs.renameSync(store+'/runtime-verification/verification.key',store+'/runtime-verification/original.key');
        original(store+'/runtime-verification/verification.key','foreign replacement',{mode:0o600});
      }
      return original(fd,bytes,...rest);
    };
  `,
  ).stdout;
  assert.equal(
    JSON.parse(output).error.code,
    "RUNTIME_VERIFICATION_REALM_UNSAFE",
  );
  assert.equal(fs.readFileSync(f.key, "utf8"), "foreign replacement");
  assert.equal(fs.existsSync(f.metadata), false);
});

for (const kind of [
  "extra-field",
  "duplicate-key",
  "wrong-key-id",
  "invalid-utf8",
  "oversized",
]) {
  test(`metadata ${kind} is rejected without modifying its bytes`, (t) => {
    const f = fixture(t);
    initializeRuntimeVerificationRealm(f.root);
    const encoded = fs.readFileSync(f.metadata, "utf8");
    const malformed =
      kind === "extra-field"
        ? encoded.replace("}", ',"extra":true}')
        : kind === "duplicate-key"
          ? encoded.replace("{", '{"version":1,')
          : kind === "wrong-key-id"
            ? encoded.replace("fmcad-rebaseline-", "foreign-")
            : kind === "invalid-utf8"
              ? Buffer.from([0xff])
              : Buffer.alloc(513, 32);
    fs.writeFileSync(f.metadata, malformed);
    const before = snapshot([f.key, f.metadata]);
    assert.throws(() => readRuntimeVerificationRealm(f.root), {
      code: "RUNTIME_VERIFICATION_REALM_INCOMPLETE",
    });
    assert.throws(() => initializeRuntimeVerificationRealm(f.root), {
      code: "RUNTIME_VERIFICATION_REALM_INCOMPLETE",
    });
    assert.deepEqual(snapshot([f.key, f.metadata]), before);
  });
}

test(
  "partial metadata reader rejects while actual writer is paused mid-write",
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t);
    const hook = `
    const original=fs.writeFileSync;
    fs.writeFileSync=(fd,bytes,...rest)=>{
      if(typeof fd==='number'&&fs.realpathSync('/proc/self/fd/'+fd).endsWith('/realm.json')){
        original(fd,bytes.subarray(0,3));
        process.send({paused:true}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
      }
      return original(fd,bytes,...rest);
    };
  `;
    const writer = spawn(
      process.execPath,
      ["-e", program, moduleFile, f.root, "init", hook],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    t.after(() => writer.kill("SIGKILL"));
    await new Promise<void>((resolve, reject) => {
      writer.once("message", () => resolve());
      writer.once("error", reject);
      writer.once("exit", () =>
        reject(new Error("writer exited before partial boundary")),
      );
    });
    const before = snapshot([f.key, f.metadata]);
    assert.equal(
      JSON.parse(child(f.root, "read").stdout).error.code,
      "RUNTIME_VERIFICATION_REALM_INCOMPLETE",
    );
    assert.deepEqual(snapshot([f.key, f.metadata]), before);
    writer.kill("SIGKILL");
    await new Promise<void>((resolve) => writer.once("exit", () => resolve()));
  },
);

test("store and realm directory substitution cannot redirect writes to foreign entries", (t) => {
  const f = fixture(t);
  const backup = f.root + ".original";
  t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
  const output = child(
    f.root,
    "init",
    `
    const original=fs.mkdirSync;
    let replaced=false;
    fs.mkdirSync=(file,...rest)=>{
      if(!replaced&&String(file).endsWith('/runtime-verification')){
        replaced=true;
        fs.renameSync(store,store+'.original');
        original(store,{mode:0o700});
        fs.writeFileSync(store+'/foreign.txt','foreign untouched',{mode:0o600});
      }
      return original(file,...rest);
    };
  `,
  ).stdout;
  assert.equal(
    JSON.parse(output).error.code,
    "RUNTIME_VERIFICATION_REALM_UNSAFE",
  );
  assert.deepEqual(fs.readdirSync(f.root), ["foreign.txt"]);
  assert.equal(
    fs.readFileSync(path.join(f.root, "foreign.txt"), "utf8"),
    "foreign untouched",
  );
  assert.equal(
    fs.existsSync(path.join(backup, "runtime-verification/verification.key")),
    false,
  );
});

test("store substitution immediately before child anchor cannot create a key in foreign realm", (t) => {
  const f = fixture(t);
  const backup = f.root + ".original";
  t.after(() => fs.rmSync(backup, { recursive: true, force: true }));
  const output = child(
    f.root,
    "init",
    `
    const original=fs.lstatSync;
    let swapped=false;
    fs.lstatSync=(file,...rest)=>{
      if(!swapped&&String(file).endsWith('/runtime-verification')){
        swapped=true;
        fs.renameSync(store,store+'.original');
        fs.mkdirSync(store,{mode:0o700});
        fs.mkdirSync(store+'/runtime-verification',{mode:0o700});
        fs.writeFileSync(store+'/runtime-verification/foreign.txt','foreign unchanged',{mode:0o600});
      }
      return original(file,...rest);
    };
  `,
  ).stdout;
  assert.equal(
    JSON.parse(output).error.code,
    "RUNTIME_VERIFICATION_REALM_UNSAFE",
  );
  assert.deepEqual(fs.readdirSync(f.realm), ["foreign.txt"]);
  assert.equal(
    fs.readFileSync(path.join(f.realm, "foreign.txt"), "utf8"),
    "foreign unchanged",
  );
  assert.equal(fs.existsSync(f.key), false);
  assert.equal(fs.existsSync(f.metadata), false);
});

test("observed existing key vanishing cannot invoke O_CREAT or RNG or replace the key", (t) => {
  const f = fixture(t);
  initializeRuntimeVerificationRealm(f.root);
  const before = snapshot([f.metadata]);
  const oldKey = hash(fs.readFileSync(f.key));
  const output = child(
    f.root,
    "init",
    `
    const stat=fs.lstatSync,open=fs.openSync,random=crypto.randomBytes;
    let removed=false,creates=0,rng=0;
    fs.lstatSync=(file,...rest)=>{
      const result=stat(file,...rest);
      if(!removed&&String(file).endsWith('/verification.key')){
        removed=true;
        fs.renameSync(store+'/runtime-verification/verification.key',store+'/runtime-verification/retired.key');
      }
      return result;
    };
    fs.openSync=(file,flags,...rest)=>{
      if(String(file).endsWith('/verification.key')&&(flags&fs.constants.O_CREAT)) creates++;
      return open(file,flags,...rest);
    };
    crypto.randomBytes=(...args)=>{rng++;return random(...args)};
    process.on('exit',()=>console.log(JSON.stringify({creates,rng})));
  `,
  )
    .stdout.trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(output[0].error.code, "RUNTIME_VERIFICATION_REALM_INCOMPLETE");
  assert.deepEqual(output[1], { creates: 0, rng: 0 });
  assert.equal(fs.existsSync(f.key), false);
  assert.equal(
    hash(fs.readFileSync(path.join(f.realm, "retired.key"))),
    oldKey,
  );
  assert.deepEqual(snapshot([f.metadata]), before);
});
