import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createDocumentObservationStore,
  type ObservationProof,
  type ObservationStoreOptions,
} from "../packages/node-adapters/src/execution/document-observation-store";

const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "observation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobDirectory = path.join(root, "jobs", "job-a");
  fs.mkdirSync(path.join(root, "jobs"), { mode: 0o700 });
  fs.mkdirSync(jobDirectory, { mode: 0o700 });
  const context = {
    version: 1,
    id: "observation-a",
    requestId: "inspect-a",
    actorClientId: "actor-a",
    target: { creationId: "doc-a", fileId: "file-a" },
    generation: "generation-a",
    scope: "parameters" as const,
    stateDigest: hash("actual parameter fixture state"),
    blockers: [],
    priorCheckpointId: null,
    createdAt: 123,
  };
  const physicalTurn = {
    version: 1 as const,
    generation: { epoch: "epoch-a", instance: "instance-a" },
    grantDigest: hash("grant"),
    target: "endpoint-a",
    turnId: "rpc-a",
    physicalRuntime: {
      birth: "birth-a",
      build: "runtime-build",
      pid: 123,
      source: "runtime-source",
      version: "runtime-v1",
    },
  };
  const binding = {
    jobId: "job-a",
    rpcId: "rpc-a",
    probeRequestId: "probe-a",
    requestHash: hash("request"),
    buildHash: hash("build"),
    sourceHash: hash("compiled-inspect-all"),
    producerManifestHash: hash("manifest"),
    physicalTurn,
  };
  const response = {
    actorClientId: context.actorClientId,
    target: context.target,
    generation: context.generation,
    stateDigest: context.stateDigest,
    probeRequestId: binding.probeRequestId,
    succeeded: true,
  };
  const files: Record<string, unknown> = {
    rpc: {
      ...binding,
      operation: "param.inspect",
      includeModel: true,
      names: null,
    },
    response,
    "physical-intent": { binding },
  };
  const proof: ObservationProof = { ...binding, artifacts: [] };
  for (const [role, value] of Object.entries(files)) {
    const name =
      role === "rpc"
        ? "rpc-rpc-a.json"
        : role === "response"
          ? "received-response-rpc-a.json"
          : `physical-turn-${hash(binding.rpcId)}.json`;
    const reference = `jobs/job-a/${name}`;
    const bytes = JSON.stringify(value);
    fs.writeFileSync(path.join(root, reference), bytes, { mode: 0o600 });
    proof.artifacts.push({ role, reference, sha256: hash(bytes) });
  }
  // Deliberately a bounded offline producer fixture, NOT the production
  // compiler/native verifier and NOT actual CAD evidence.
  const verifyProducer: ObservationStoreOptions["verifyProducer"] = (input) => {
    const rpc = input.artifacts.find((a) => a.role === "rpc")!
      .value as typeof binding & {
      operation: string;
      includeModel: boolean;
      names: unknown;
    };
    const result = input.artifacts.find((a) => a.role === "response")!
      .value as typeof response;
    const intent = input.artifacts.find((a) => a.role === "physical-intent")!
      .value as { binding: typeof binding };
    assert.deepEqual(input.proof, {
      ...binding,
      artifacts: input.proof.artifacts,
    });
    assert.deepEqual(intent.binding, binding);
    assert.deepEqual(rpc, {
      ...binding,
      operation: "param.inspect",
      includeModel: true,
      names: null,
    });
    assert.equal(result.succeeded, true);
    return {
      actorClientId: result.actorClientId,
      target: result.target,
      generation: result.generation,
      stateDigest: result.stateDigest,
      probeRequestId: result.probeRequestId,
      proof: input.proof,
    };
  };
  const options = { directory: root, namespace: "queue-a", verifyProducer };
  const store = createDocumentObservationStore(options);
  function publish() {
    return { ...context, readback: store.persist(context, proof) };
  }
  function replaceSource(
    role: string,
    change: (value: Record<string, unknown>) => void,
  ) {
    const artifact = proof.artifacts.find((a) => a.role === role)!;
    const file = path.join(root, artifact.reference);
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    change(value);
    const bytes = JSON.stringify(value);
    fs.writeFileSync(file, bytes);
    artifact.sha256 = hash(bytes); // A coherent attacker also updates public hashes.
  }
  return { root, context, proof, store, options, publish, replaceSource };
}

test("durable immutable publication and new-store restoration preserve exact bytes", (t) => {
  const f = fixture(t);
  const observation = f.publish();
  const file = path.join(f.root, observation.readback.reference);
  const before = fs.readFileSync(file);
  const stat = fs.statSync(file);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.nlink, 1);
  assert.deepEqual(f.store.persist(f.context, f.proof), observation.readback);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.statSync(file).ino, stat.ino);
  createDocumentObservationStore(f.options).verify(observation);
  assert.throws(() =>
    f.store.persist({ ...f.context, requestId: "other" }, f.proof),
  );
  assert.deepEqual(fs.readFileSync(file), before);
});

for (const kind of [
  "tamper",
  "truncate",
  "missing",
  "malformed",
  "utf8",
] as const) {
  test(`restore rejects ${kind} record`, (t) => {
    const f = fixture(t);
    const observation = f.publish();
    const file = path.join(f.root, observation.readback.reference);
    if (kind === "missing") fs.unlinkSync(file);
    else {
      fs.writeFileSync(
        file,
        kind === "tamper"
          ? "{}"
          : kind === "truncate"
            ? '{"version":'
            : kind === "utf8"
              ? Buffer.from([0xff])
              : "not json",
      );
      // Even a matching hash cannot promote malformed evidence.
      observation.readback.sha256 = hash(fs.readFileSync(file));
    }
    assert.throws(() => f.store.verify(observation));
  });
}

test("missing or changed producer artifact invalidates an otherwise intact record", (t) => {
  const f = fixture(t);
  const observation = f.publish();
  const file = path.join(f.root, f.proof.artifacts[1]!.reference);
  fs.writeFileSync(file, "{}");
  assert.throws(() => f.store.verify(observation));
  fs.unlinkSync(file);
  assert.throws(() => f.store.verify(observation));
});

test("copied record from B and another namespace do not restore authority", (t) => {
  const a = fixture(t),
    b = fixture(t);
  const observation = a.publish(),
    foreign = b.publish();
  const file = path.join(a.root, observation.readback.reference);
  fs.copyFileSync(path.join(b.root, foreign.readback.reference), file);
  observation.readback.sha256 = hash(fs.readFileSync(file));
  assert.throws(() => a.store.verify(observation));
  const local = b.publish();
  assert.throws(() =>
    createDocumentObservationStore({
      ...b.options,
      namespace: "queue-b",
    }).verify(local),
  );
});

for (const field of [
  "actorClientId",
  "target",
  "generation",
  "stateDigest",
  "probeRequestId",
]) {
  test(`coherently rehashed foreign ${field} response is not verified`, (t) => {
    const f = fixture(t);
    f.replaceSource("response", (value) => {
      value[field] = field === "target" ? { creationId: "doc-b" } : "foreign-b";
    });
    assert.throws(() => f.publish());
    assert.deepEqual(
      fs.readdirSync(path.join(f.root, "document-observations")),
      [],
    );
  });
}

for (const field of ["names", "includeModel", "sourceHash", "rpcId"]) {
  test(`wrong ${field} producer is rejected despite updated artifact hash`, (t) => {
    const f = fixture(t);
    f.replaceSource("rpc", (value) => {
      value[field] =
        field === "names"
          ? ["hidden"]
          : field === "includeModel"
            ? false
            : "wrong";
    });
    assert.throws(() => f.publish());
  });
}

test("unsafe references and cross-job sources fail before publication", (t) => {
  const f = fixture(t);
  for (const reference of [
    "../outside",
    "/etc/passwd",
    "jobs/job-b/response.json",
    "jobs/job-a/../response.json",
    "jobs/job-a\\response.json",
  ]) {
    const proof = copy(f.proof);
    proof.artifacts[0]!.reference = reference;
    assert.throws(() => f.store.persist(f.context, proof));
  }
});

for (const kind of ["symlink", "hardlink", "permissions", "fifo"] as const) {
  test(
    `unsafe ${kind} source fails without opening a blocking FIFO`,
    { timeout: 2000 },
    (t) => {
      const f = fixture(t);
      const file = path.join(f.root, f.proof.artifacts[0]!.reference);
      if (kind === "permissions") fs.chmodSync(file, 0o644);
      else {
        const other = file + ".original";
        fs.renameSync(file, other);
        if (kind === "symlink") fs.symlinkSync(other, file);
        if (kind === "hardlink") {
          fs.linkSync(other, file);
        }
        if (kind === "fifo") execFileSync("mkfifo", ["-m", "600", file]);
      }
      assert.throws(() => f.publish());
    },
  );
}

test("source and directory swaps during verification fail closed", (t) => {
  const f = fixture(t);
  const store = createDocumentObservationStore({
    ...f.options,
    verifyProducer(input) {
      const result = f.options.verifyProducer(input);
      fs.writeFileSync(
        path.join(f.root, f.proof.artifacts[0]!.reference),
        "{}",
      );
      return result;
    },
  });
  assert.throws(() => store.persist(f.context, f.proof));
  const g = fixture(t);
  const directory = path.join(g.root, "document-observations");
  fs.renameSync(directory, directory + ".old");
  fs.mkdirSync(directory, { mode: 0o700 });
  assert.throws(() => g.publish());
});

test("orphan record is evidence only and does not enumerate or authorize checkpoints", (t) => {
  const f = fixture(t);
  f.publish(); // Simulate crash before snapshot's reference publication.
  const reopened = createDocumentObservationStore(f.options);
  assert.deepEqual(Object.keys(reopened).sort(), ["persist", "verify"]);
  assert.throws(() =>
    reopened.verify({
      ...f.context,
      readback: {
        reference: "document-observations/missing.json",
        sha256: hash("missing"),
        probeRequestId: "probe-a",
      },
    }),
  );
});

test("fsync failure never returns a successful reference; exact retry can reconcile", (t) => {
  const f = fixture(t);
  let fail = false;
  const io = {
    ...fs,
    fsyncSync(fd: number) {
      if (fail) throw Object.assign(new Error("disk failure"), { code: "EIO" });
      return fs.fsyncSync(fd);
    },
  };
  const store = createDocumentObservationStore({ ...f.options, io });
  fail = true;
  assert.throws(() => store.persist(f.context, f.proof), /disk failure/);
  assert.deepEqual(
    fs.readdirSync(path.join(f.root, "document-observations")),
    [],
  );
  fail = false;
  store.verify({ ...f.context, readback: store.persist(f.context, f.proof) });
});

test("boolean pseudo-verifier cannot create authority", (t) => {
  const f = fixture(t);
  const store = createDocumentObservationStore({
    ...f.options,
    verifyProducer: (() =>
      true) as unknown as ObservationStoreOptions["verifyProducer"],
  });
  assert.throws(() => store.persist(f.context, f.proof));
});

test("record symlink, hardlink and public permissions are rejected on restore", (t) => {
  for (const kind of ["symlink", "hardlink", "permissions"]) {
    const f = fixture(t);
    const observation = f.publish();
    const file = path.join(f.root, observation.readback.reference);
    if (kind === "permissions") fs.chmodSync(file, 0o644);
    else {
      fs.renameSync(file, file + ".original");
      if (kind === "symlink") fs.symlinkSync(file + ".original", file);
      else fs.linkSync(file + ".original", file);
    }
    assert.throws(() => f.store.verify(observation));
  }
});

test(
  "FIFO observation without writer is rejected without blocking",
  { timeout: 2000 },
  (t) => {
    const f = fixture(t);
    const observation = f.publish();
    const file = path.join(f.root, observation.readback.reference);
    fs.unlinkSync(file);
    execFileSync("mkfifo", ["-m", "600", file]);
    assert.throws(() => f.store.verify(observation));
  },
);

test("private source directory identity and permissions are enforced", (t) => {
  const f = fixture(t);
  const jobs = path.join(f.root, "jobs");
  fs.chmodSync(jobs, 0o755);
  assert.throws(() => f.publish());
  fs.chmodSync(jobs, 0o700);
  fs.renameSync(jobs, jobs + ".original");
  fs.symlinkSync(jobs + ".original", jobs);
  assert.throws(() => f.publish());
});

test("rehashed invalid UTF8 or oversized source is rejected before producer callback", (t) => {
  for (const bytes of [
    Buffer.from([0xff]),
    Buffer.alloc(16 * 1024 * 1024 + 1, 32),
  ]) {
    const f = fixture(t);
    const artifact = f.proof.artifacts[0]!;
    fs.writeFileSync(path.join(f.root, artifact.reference), bytes);
    artifact.sha256 = hash(bytes);
    let called = false;
    const store = createDocumentObservationStore({
      ...f.options,
      verifyProducer(input) {
        called = true;
        return f.options.verifyProducer(input);
      },
    });
    assert.throws(() => store.persist(f.context, f.proof));
    assert.equal(called, false);
  }
});

test("artifact replacement between lstat and FD read is refused", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, f.proof.artifacts[0]!.reference);
  let swapped = false;
  const io = {
    ...fs,
    openSync(...args: Parameters<typeof fs.openSync>) {
      if (args[0] === file && !swapped) {
        swapped = true;
        fs.renameSync(file, file + ".old");
        fs.copyFileSync(file + ".old", file);
      }
      return fs.openSync(...args);
    },
  };
  const store = createDocumentObservationStore({ ...f.options, io });
  assert.throws(() => store.persist(f.context, f.proof));
  assert.equal(swapped, true);
});

test("output directory replacement cannot redirect exclusive publication", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside, { mode: 0o700 });
  const directory = path.join(f.root, "document-observations");
  let swapped = false;
  const io = {
    ...fs,
    writeFileSync(...args: Parameters<typeof fs.writeFileSync>) {
      if (!swapped) {
        swapped = true;
        fs.renameSync(directory, directory + ".old");
        fs.symlinkSync(outside, directory);
      }
      return fs.writeFileSync(...args);
    },
  };
  const store = createDocumentObservationStore({ ...f.options, io });
  assert.throws(() => store.persist(f.context, f.proof));
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("directory fsync fault after exclusive link leaves only an unreferenced orphan", (t) => {
  const f = fixture(t);
  let armed = false;
  const io = {
    ...fs,
    fsyncSync(fd: number) {
      if (armed && fs.fstatSync(fd).isDirectory())
        throw Object.assign(new Error("directory durability unknown"), {
          code: "EIO",
        });
      return fs.fsyncSync(fd);
    },
  };
  const store = createDocumentObservationStore({ ...f.options, io });
  armed = true;
  assert.throws(() => store.persist(f.context, f.proof), /durability unknown/);
  assert.equal(
    fs.readdirSync(path.join(f.root, "document-observations")).length,
    1,
  );
  const recovered = createDocumentObservationStore(f.options);
  const readback = recovered.persist(f.context, f.proof);
  recovered.verify({ ...f.context, readback });
});

test("stale physical generation/runtime and foreign probe bindings cannot publish", (t) => {
  const f = fixture(t);
  for (const change of [
    (p: ObservationProof) => {
      p.probeRequestId = "foreign-probe";
    },
    (p: ObservationProof) => {
      p.physicalTurn.generation.epoch = "stale";
    },
    (p: ObservationProof) => {
      p.physicalTurn.physicalRuntime.build = "stale";
    },
    (p: ObservationProof) => {
      p.requestHash = hash("other-request");
    },
  ]) {
    const proof = copy(f.proof);
    change(proof);
    assert.throws(() => f.store.persist(f.context, proof));
  }
  assert.deepEqual(
    fs.readdirSync(path.join(f.root, "document-observations")),
    [],
  );
});

test("source mutation during durable publication cannot return a reference", (t) => {
  const f = fixture(t);
  let changed = false;
  let armed = false;
  const io = {
    ...fs,
    fsyncSync(fd: number) {
      if (armed && !changed && fs.fstatSync(fd).isDirectory()) {
        changed = true;
        fs.writeFileSync(
          path.join(f.root, f.proof.artifacts[0]!.reference),
          "{}",
        );
      }
      fs.fsyncSync(fd);
    },
  };
  const store = createDocumentObservationStore({ ...f.options, io });
  armed = true;
  assert.throws(() => store.persist(f.context, f.proof));
  assert.equal(changed, true);
});

test("identical copies under noncanonical role names cannot replace original sources", (t) => {
  for (const role of ["rpc", "response", "physical-intent"]) {
    const f = fixture(t);
    const source = f.proof.artifacts.find((a) => a.role === role)!;
    const original = path.join(f.root, source.reference);
    const replacement = `jobs/job-a/${role}.json`;
    fs.renameSync(original, path.join(f.root, replacement));
    source.reference = replacement;
    assert.throws(() => f.publish(), /canonical artifact/);
    assert.equal(fs.existsSync(original), false);
  }
});

test("reopen after root fsync failure must resync the existing directory entry", (t) => {
  const f = fixture(t);
  const directory = path.join(f.root, "document-observations");
  fs.rmdirSync(directory);
  const rootInode = fs.statSync(f.root).ino;
  let failures = 2;
  let rootSyncs = 0;
  const io = {
    ...fs,
    fsyncSync(fd: number) {
      if (fs.fstatSync(fd).ino === rootInode) {
        rootSyncs++;
        if (failures-- > 0) throw new Error("root fsync EIO");
      }
      fs.fsyncSync(fd);
    },
  };
  assert.throws(
    () => createDocumentObservationStore({ ...f.options, io }),
    /root fsync EIO/,
  );
  assert.equal(fs.existsSync(directory), true);
  assert.throws(
    () => createDocumentObservationStore({ ...f.options, io }),
    /root fsync EIO/,
  );
  const reopened = createDocumentObservationStore({ ...f.options, io });
  const readback = reopened.persist(f.context, f.proof);
  reopened.verify({ ...f.context, readback });
  assert.equal(rootSyncs, 3);
});

test("last temporary unlink is followed by fsync on the pinned directory", (t) => {
  const f = fixture(t);
  const inode = fs.statSync(path.join(f.root, "document-observations")).ino;
  const events: string[] = [];
  const io = {
    ...fs,
    unlinkSync(file: fs.PathLike) {
      fs.unlinkSync(file);
      events.push("unlink");
    },
    fsyncSync(fd: number) {
      fs.fsyncSync(fd);
      if (fs.fstatSync(fd).ino === inode) events.push("directory-fsync");
    },
  };
  const store = createDocumentObservationStore({ ...f.options, io });
  store.persist(f.context, f.proof);
  assert.deepEqual(events, ["directory-fsync", "unlink", "directory-fsync"]);
});

test("interrupted temporary unlink fails closed on retry without touching either name", (t) => {
  const f = fixture(t);
  let armed = true;
  const io = {
    ...fs,
    unlinkSync(file: fs.PathLike) {
      if (armed) {
        armed = false;
        throw new Error("unlink interrupted");
      }
      fs.unlinkSync(file);
    },
  };
  const store = createDocumentObservationStore({ ...f.options, io });
  assert.throws(() => store.persist(f.context, f.proof), /unlink interrupted/);
  const directory = path.join(f.root, "document-observations");
  const final = fs
    .readdirSync(directory)
    .find((name) => name.endsWith(".json"))!;
  const file = path.join(directory, final);
  const before = fs.statSync(file),
    bytes = fs.readFileSync(file);
  const names = fs.readdirSync(directory);
  assert.equal(before.nlink, 2);
  const recovered = createDocumentObservationStore(f.options);
  assert.throws(
    () => recovered.persist(f.context, f.proof),
    /private, owned and regular/,
  );
  assert.equal(fs.statSync(file).ino, before.ino);
  assert.equal(fs.statSync(file).nlink, 2);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.deepEqual(fs.readdirSync(directory), names);
});

test("restore never cleans a discovered UUID temporary hardlink or unrelated file", (t) => {
  const f = fixture(t);
  const observation = f.publish();
  const file = path.join(f.root, observation.readback.reference);
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.linkSync(file, temporary); // Model a resurrected unsynced unlink after crash.
  const foreign = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(foreign, "unrelated owned file", { mode: 0o600 });
  assert.throws(
    () => createDocumentObservationStore(f.options).verify(observation),
    /private, owned and regular/,
  );
  assert.equal(fs.existsSync(temporary), true);
  assert.equal(fs.readFileSync(foreign, "utf8"), "unrelated owned file");
  assert.equal(fs.statSync(file).nlink, 2);
});

test("foreign hardlink is not forcibly removed during restore or retry", (t) => {
  const f = fixture(t);
  const observation = f.publish();
  const file = path.join(f.root, observation.readback.reference);
  const foreign = `${file}.not-a-publication`;
  fs.linkSync(file, foreign);
  assert.throws(
    () => f.store.verify(observation),
    /private, owned and regular/,
  );
  assert.throws(
    () => f.store.persist(f.context, f.proof),
    /private, owned and regular/,
  );
  assert.equal(fs.statSync(file).nlink, 2);
  assert.deepEqual(fs.readFileSync(foreign), fs.readFileSync(file));
});

test("multi-link restore and retry reject before any discovered-name unlink or swap", (t) => {
  const f = fixture(t);
  const observation = f.publish();
  const file = path.join(f.root, observation.readback.reference);
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.linkSync(file, temporary);
  const originalBytes = fs.readFileSync(temporary);
  let unlinkAttempts = 0;
  const io = {
    ...fs,
    unlinkSync(entry: fs.PathLike) {
      unlinkAttempts++;
      // If stat-then-unlink recovery regresses, another process substitutes a
      // foreign file at the EXACT discovered UUID name before this unlink.
      if (String(entry).endsWith(path.basename(temporary))) {
        execFileSync(process.execPath, [
          "-e",
          `
          const fs=require('node:fs'),file=process.argv[1];
          fs.renameSync(file,file+'.original');
          fs.writeFileSync(file,'foreign replacement',{mode:0o600});
        `,
          temporary,
        ]);
      }
      fs.unlinkSync(entry);
    },
  };
  const store = createDocumentObservationStore({ ...f.options, io });
  assert.throws(() => store.verify(observation));
  assert.equal(unlinkAttempts, 0);
  assert.throws(() => store.persist(f.context, f.proof));
  assert.equal(unlinkAttempts, 0);
  assert.deepEqual(fs.readFileSync(temporary), originalBytes);
  assert.equal(fs.statSync(temporary).ino, fs.statSync(file).ino);
  assert.equal(fs.statSync(file).nlink, 2);
  assert.equal(fs.existsSync(temporary + ".original"), false);
});

test("reopen reasserts final-unlink durability even when visible nlink is already one", (t) => {
  const f = fixture(t);
  const inode = fs.statSync(path.join(f.root, "document-observations")).ino;
  let unlinked = false;
  const io = {
    ...fs,
    unlinkSync(file: fs.PathLike) {
      fs.unlinkSync(file);
      unlinked = true;
    },
    fsyncSync(fd: number) {
      if (unlinked && fs.fstatSync(fd).ino === inode)
        throw new Error("final-unlink fsync EIO");
      fs.fsyncSync(fd);
    },
  };
  const store = createDocumentObservationStore({ ...f.options, io });
  assert.throws(
    () => store.persist(f.context, f.proof),
    /final-unlink fsync EIO/,
  );
  const reference = `document-observations/${hash(f.context.id)}.json`;
  const file = path.join(f.root, reference);
  assert.equal(fs.statSync(file).nlink, 1);
  const observation = {
    ...f.context,
    readback: {
      reference,
      sha256: hash(fs.readFileSync(file)),
      probeRequestId: f.proof.probeRequestId,
    },
  };
  // Root initialization can succeed, but visible file bytes cannot bypass the
  // required child-directory durability reassertion at restore.
  const reopened = createDocumentObservationStore({ ...f.options, io });
  assert.throws(() => reopened.verify(observation), /final-unlink fsync EIO/);
  createDocumentObservationStore(f.options).verify(observation);
});

for (const variant of ["identity", "permissions", "hardlink"] as const) {
  test(`another process swapping an opened source ${variant} is rejected at FD boundary`, (t) => {
    const f = fixture(t);
    const source = path.join(f.root, f.proof.artifacts[0]!.reference);
    const job = path.dirname(source),
      backup = job + ".original";
    const original = fs.statSync(source);
    let armed = true,
      didRead = false,
      switched = false;
    const child = (code: string) =>
      execFileSync(process.execPath, ["-e", code, job, backup, source]);
    const io = {
      ...fs,
      openSync(...args: Parameters<typeof fs.openSync>) {
        if (args[0] === source && armed) {
          armed = false;
          child(`
            const fs=require('node:fs'),path=require('node:path');
            const [job,backup,source]=process.argv.slice(1);
            fs.renameSync(job,backup);
            fs.cpSync(backup,job,{recursive:true});
            fs.chmodSync(job,0o700);
            ${variant === "permissions" ? "fs.chmodSync(source,0o644);" : ""}
            ${variant === "hardlink" ? "fs.linkSync(source,source+'.link');" : ""}
          `);
          switched = true;
        }
        return fs.openSync(...args);
      },
      readSync: new Proxy(fs.readSync, {
        apply(target, receiver, args) {
          if (switched) didRead = true;
          return Reflect.apply(target, receiver, args);
        },
      }),
      closeSync(fd: number) {
        fs.closeSync(fd);
        if (switched) {
          child(`
            const fs=require('node:fs');
            const [job,backup]=process.argv.slice(1);
            fs.rmSync(job,{recursive:true}); fs.renameSync(backup,job);
          `);
          switched = false;
        }
      },
    };
    const store = createDocumentObservationStore({ ...f.options, io });
    assert.throws(
      () => store.persist(f.context, f.proof),
      variant === "identity"
        ? /Opened observation inode/
        : /private, owned and regular/,
    );
    assert.equal(didRead, false);
    const restored = fs.statSync(source);
    assert.deepEqual(
      [
        restored.ino,
        restored.mode,
        restored.nlink,
        restored.mtimeMs,
        restored.ctimeMs,
      ],
      [
        original.ino,
        original.mode,
        original.nlink,
        original.mtimeMs,
        original.ctimeMs,
      ],
    );
  });
}
