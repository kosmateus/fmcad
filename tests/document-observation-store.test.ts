import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
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
    const reference = `jobs/job-a/${role}.json`;
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
  let fail = true;
  const io = {
    ...fs,
    fsyncSync(fd: number) {
      if (fail) throw Object.assign(new Error("disk failure"), { code: "EIO" });
      return fs.fsyncSync(fd);
    },
  };
  const store = createDocumentObservationStore({ ...f.options, io });
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
  const io = {
    ...fs,
    fsyncSync(fd: number) {
      if (fs.fstatSync(fd).isDirectory())
        throw Object.assign(new Error("directory durability unknown"), {
          code: "EIO",
        });
      return fs.fsyncSync(fd);
    },
  };
  const store = createDocumentObservationStore({ ...f.options, io });
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
  const io = {
    ...fs,
    fsyncSync(fd: number) {
      if (!changed && fs.fstatSync(fd).isDirectory()) {
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
  assert.throws(() => store.persist(f.context, f.proof));
  assert.equal(changed, true);
});
