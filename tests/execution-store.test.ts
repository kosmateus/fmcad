import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import {
  object,
  field,
  string,
  number,
  present,
} from "./modeling-unit-test-support.js";
const fixtureDirectory = path.join(process.cwd(), "tests");
const load = createRequire(
  path.join(fixtureDirectory, "execution-store.test.ts"),
);
const records = load(
  "../src/dist/node-adapters/persistence/records",
) as typeof import("../packages/node-adapters/src/persistence/records.js");
const artifacts = load(
  "../src/queue-response-files",
) as typeof import("../packages/node-adapters/src/persistence/owned-results.js");
const inputs = load(
  "../src/dist/node-adapters/persistence/accepted-inputs",
) as typeof import("../packages/node-adapters/src/persistence/accepted-inputs.js");
const { startStdio } = load(
  "../src/mcp-stdio",
) as typeof import("../src/entrypoints/mcp-stdio.js");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync("/tmp/opencode/execution-store-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "queue"),
    project = path.join(root, "project");
  fs.mkdirSync(path.join(dir, "jobs/task"), { recursive: true });
  fs.mkdirSync(path.join(project, ".cad"), { recursive: true });
  return {
    root,
    dir,
    project,
    job: { id: "task", state: "succeeded", request: { cwd: project } },
  };
}

for (const [stage, code] of [
  ["writeFileSync", "ENOSPC"],
  ["renameSync", "EIO"],
  ["fsyncSync", "EIO"],
  ["openSync", "EROFS"],
] as const) {
  test(`snapshot ${stage}/${code} fails closed and never invents a committed result`, (t) => {
    const f = fixture(t),
      file = path.join(f.dir, "queue-state.json");
    records.createSnapshotStore(f.dir).commit('{"version":1,"revision":1}');
    let calls = 0;
    const io = new Proxy(fs, {
      get(target, property, receiver) {
        if (property !== stage) return Reflect.get(target, property, receiver);
        return new Proxy(target[stage], {
          apply(method, receiver, args: unknown[]) {
            calls++;
            // For write/fsync/rename, allow the pending journal to become durable first.
            const targetCall =
              stage === "fsyncSync" ? 3 : stage === "writeFileSync" ? 2 : 1;
            if (calls === targetCall)
              throw Object.assign(new Error("injected " + code), { code });
            return Reflect.apply(method, receiver, args);
          },
        });
      },
    });
    const store = records.createSnapshotStore(f.dir, io);
    assert.throws(() => store.commit('{"version":1,"revision":2}'), {
      code: "STORAGE_UNAVAILABLE",
    });
    assert.throws(() => store.commit("{}"), { code: "STORAGE_UNAVAILABLE" });
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")));
    if (stage !== "openSync") {
      assert.equal(
        fs.existsSync(path.join(f.dir, "queue-state.pending.json")),
        true,
      );
      assert.throws(() => records.createSnapshotStore(f.dir).restore(), {
        code: "STORAGE_UNAVAILABLE",
      });
    }
  });
}

test("post-rename directory fsync failure survives restart as a durable fault", (t) => {
  const f = fixture(t);
  let syncs = 0;
  const io = {
    ...fs,
    fsyncSync(fd: number) {
      if (++syncs === 4) throw new Error("directory sync");
      fs.fsyncSync(fd);
    },
  };
  assert.throws(
    () => records.createSnapshotStore(f.dir, io).commit('{"revision":2}'),
    /uncertain/,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(f.dir, "queue-state.json"), "utf8")),
    { revision: 2 },
  );
  assert.throws(() => records.createSnapshotStore(f.dir).restore(), {
    code: "STORAGE_UNAVAILABLE",
  });
});

test("exclusive receipts retain old bytes on failure, corruption and invalid limits are rejected", (t) => {
  const f = fixture(t),
    file = path.join(f.dir, "receipt.json");
  records.durable(file, { terminal: false }, true);
  assert.throws(() => records.durable(file, { terminal: true }, true), {
    code: "EEXIST",
  });
  assert.deepEqual(records.readJson(file), { terminal: false });
  assert.throws(() => records.readJson(file, 1), { code: "CORRUPT_STATE" });
  assert.throws(() => records.readJson(file, 0), { code: "INVALID_LIMIT" });
  fs.writeFileSync(file, '{"terminal":');
  assert.throws(() => records.readJson(file), SyntaxError);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => records.readJson(file), /regular file/);
});

test("dangling fault journals and dangling project results are not treated as absent", (t) => {
  const f = fixture(t);
  fs.symlinkSync(
    path.join(f.root, "absent"),
    path.join(f.dir, "queue-state.pending.json"),
  );
  assert.throws(() => records.createSnapshotStore(f.dir).restore(), {
    code: "STORAGE_UNAVAILABLE",
  });
  const result = artifacts.responsePath(f.dir, f.job, "rpc-result.json", true);
  fs.symlinkSync(path.join(f.root, "absent-result"), result);
  fs.writeFileSync(path.join(f.dir, "jobs/task/rpc-result.json"), "{}");
  assert.throws(() => artifacts.jobOutputs(f.dir, f.job), {
    code: "INVALID_ARTIFACT",
  });
});

test("owned descriptors bind hash, job, scope and limit without trusting response paths", (t) => {
  const f = fixture(t),
    name = "rpc-result.json";
  const file = artifacts.responsePath(f.dir, f.job, name, true);
  fs.writeFileSync(file, '{"original":true}');
  const descriptor = artifacts.describeOwnedResult(f.dir, f.job, name);
  const expected = { jobId: f.job.id, cwd: f.project };
  assert.equal(
    artifacts
      .readOwnedResult(f.dir, expected, descriptor["artifact"])
      .toString(),
    '{"original":true}',
  );
  for (const patch of [
    { jobId: "other" },
    { scope: "foreign" },
    { sha256: "0".repeat(64) },
    { path: "/etc/passwd" },
    { version: 2 },
    { bytes: 99 },
  ]) {
    assert.throws(
      () =>
        Reflect.apply(artifacts.readOwnedResult, undefined, [
          f.dir,
          expected,
          { ...descriptor["artifact"], ...patch },
        ]),
      { code: "INVALID_ARTIFACT" },
    );
  }
  assert.throws(
    () => artifacts.readOwnedResult(f.dir, expected, descriptor["artifact"], 1),
    { code: "INVALID_ARTIFACT" },
  );
  const foreign = path.join(f.root, "foreign");
  fs.mkdirSync(foreign);
  assert.throws(
    () =>
      artifacts.readOwnedResult(
        f.dir,
        { ...expected, cwd: foreign },
        descriptor["artifact"],
      ),
    { code: "INVALID_ARTIFACT" },
  );
  fs.writeFileSync(file, '{"changed":false}');
  assert.throws(
    () => artifacts.readOwnedResult(f.dir, expected, descriptor["artifact"]),
    { code: "INVALID_ARTIFACT" },
  );
});

test("polling a growing worker log returns one coherent bounded prefix, not a false hash fault", (t) => {
  const f = fixture(t),
    file = artifacts.responsePath(f.dir, f.job, "stdout.txt", true);
  fs.writeFileSync(file, "initial");
  const original = fs.readSync;
  let appended = false;
  fs.readSync = new Proxy(original, {
    apply(method, receiver, args: unknown[]) {
      const fd = number(args[0]);
      const count: unknown = Reflect.apply(method, receiver, args);
      if (!appended && fs.realpathSync(`/proc/self/fd/${fd}`) === file) {
        appended = true;
        fs.appendFileSync(file, "+later");
      }
      return count;
    },
  });
  try {
    assert.equal(
      field(artifacts.jobOutputs(f.dir, f.job), "stdout"),
      "initial",
    );
  } finally {
    fs.readSync = original;
  }
  assert.equal(appended, true);
  assert.equal(
    field(artifacts.jobOutputs(f.dir, f.job), "stdout"),
    "initial+later",
  );
});

test("owned reads refuse symlink file, job directory and .cad directory; legacy is bounded", (t) => {
  const f = fixture(t),
    expected = { jobId: "task", cwd: f.project };
  const legacy = path.join(f.dir, "jobs/task/rpc-result.json");
  fs.writeFileSync(legacy, "{}");
  const reference = artifacts.describeOwnedResult(
    f.dir,
    f.job,
    "rpc-result.json",
  ).artifact;
  assert.equal(reference.storage, "legacy");
  assert.equal(
    artifacts.readOwnedResult(f.dir, expected, reference).toString(),
    "{}",
  );
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "rpc-result.json"), "{}");
  fs.unlinkSync(legacy);
  fs.symlinkSync(path.join(outside, "rpc-result.json"), legacy);
  assert.throws(() => artifacts.readOwnedResult(f.dir, expected, reference), {
    code: "ELOOP",
  });
  fs.unlinkSync(legacy);
  fs.rmdirSync(path.dirname(legacy));
  fs.symlinkSync(outside, path.dirname(legacy));
  assert.throws(
    () => artifacts.readOwnedResult(f.dir, expected, reference),
    /regular directories/,
  );
  fs.rmdirSync(path.join(f.project, ".cad"));
  fs.symlinkSync(outside, path.join(f.project, ".cad"));
  assert.throws(
    () => artifacts.responsePath(f.dir, f.job, "rpc-result.json"),
    /regular directory/,
  );
});

test("opened inode containment rejects a raced parent symlink substitution", (t) => {
  const f = fixture(t),
    file = path.join(f.dir, "jobs/task/rpc-result.json");
  const outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "rpc-result.json"), "{}");
  fs.writeFileSync(file, "{}");
  const io = {
    ...fs,
    openSync: new Proxy(fs.openSync, {
      apply(method, receiver, args: unknown[]) {
        if (args[0] === file) {
          fs.unlinkSync(file);
          fs.rmdirSync(path.dirname(file));
          fs.symlinkSync(outside, path.dirname(file));
        }
        return Reflect.apply(method, receiver, args);
      },
    }),
  };
  assert.throws(() => records.readBytes(file, 1024, io, file), {
    code: "INVALID_ARTIFACT",
  });
});

test("temp and panel cleanup cannot remove retained scheduler, receipt or project result evidence", (t) => {
  const f = fixture(t),
    temp = path.join(f.root, "temp"),
    panel = path.join(f.project, ".cad/control-center");
  fs.mkdirSync(temp);
  fs.mkdirSync(panel);
  fs.writeFileSync(path.join(temp, "diagnostic.log"), "log");
  fs.writeFileSync(path.join(panel, "control-center.sqlite"), "read model");
  records
    .createSnapshotStore(f.dir)
    .commit('{"version":1,"jobs":{"task":{"state":"needs_reconciliation"}}}');
  records.durable(
    path.join(f.dir, "jobs/task/receipt.json"),
    { terminal: false },
    true,
  );
  const file = artifacts.responsePath(f.dir, f.job, "rpc-result.json", true);
  fs.writeFileSync(file, '{"result":"retained"}');
  fs.rmSync(temp, { recursive: true });
  fs.rmSync(panel, { recursive: true });
  assert.equal(
    field(
      JSON.parse(present(records.createSnapshotStore(f.dir).restore())),
      "jobs",
      "task",
      "state",
    ),
    "needs_reconciliation",
  );
  assert.deepEqual(
    records.readJson(path.join(f.dir, "jobs/task/receipt.json")),
    { terminal: false },
  );
  const descriptor = artifacts.describeOwnedResult(
    f.dir,
    f.job,
    "rpc-result.json",
  );
  assert.equal(
    artifacts
      .readOwnedResult(
        f.dir,
        { jobId: "task", cwd: f.project },
        descriptor["artifact"],
      )
      .toString(),
    '{"result":"retained"}',
  );
});

test("accepted bytes/provenance survive source edits; missing legacy bytes never use current source", (t) => {
  const f = fixture(t),
    source = path.join(f.project, "run.py"),
    bytes = Buffer.from('print("accepted")\r\n');
  fs.writeFileSync(source, bytes);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const references = inputs.captureAcceptedInputs(f.dir, {
    cwd: f.project,
    inputFiles: [{ path: "run.py", sha256 }],
    payload: { source: "accepted" },
  });
  fs.writeFileSync(source, 'print("different")');
  const acceptedSource = inputs.readAcceptedInput(
    f.dir,
    present(references[1]),
  );
  assert.ok(acceptedSource.status === "available");
  assert.deepEqual(acceptedSource.bytes, bytes);
  assert.equal(acceptedSource.provenance.originalPath, source);
  const acceptedPayload = inputs.readAcceptedInput(
    f.dir,
    present(references[0]),
  );
  assert.ok(acceptedPayload.status === "available");
  assert.deepEqual(JSON.parse(acceptedPayload.bytes.toString("utf8")), {
    source: "accepted",
  });
  assert.throws(
    () =>
      inputs.captureAcceptedInputs(f.dir, {
        cwd: f.project,
        inputFiles: [{ path: source, sha256 }],
      }),
    { code: "INPUT_CHANGED" },
  );
  fs.unlinkSync(path.join(f.dir, "accepted", sha256));
  assert.deepEqual(inputs.readAcceptedInput(f.dir, references[1]), {
    status: "missing",
  });
  assert.deepEqual(inputs.readAcceptedInput(f.dir), { status: "missing" });
});

test("immutable admission provenance is independent of queue hashes and reuses bytes on retries", (t) => {
  const f = fixture(t),
    file = path.join(f.project, "run.py");
  fs.writeFileSync(file, "accepted");
  const request = {
    clientId: "owner",
    requestId: "request",
    cwd: f.project,
    payload: { b: 2, a: 1 },
    inputFiles: [
      {
        path: file,
        sha256: crypto.createHash("sha256").update("accepted").digest("hex"),
      },
    ],
  };
  const original = JSON.stringify(request);
  inputs.retainAdmission(f.dir, request);
  assert.equal(JSON.stringify(request), original);
  fs.writeFileSync(file, "later");
  inputs.retainAdmission(f.dir, { ...request, payload: { a: 1, b: 2 } });
  const admission = inputs.readAdmission(f.dir, request);
  assert.equal(admission.status, "available");
  assert.ok(admission.status === "available");
  const accepted = inputs.readAcceptedInput(
    f.dir,
    present(admission.inputs[1]),
  );
  assert.ok(accepted.status === "available");
  assert.equal(accepted.bytes.toString(), "accepted");
  assert.throws(
    () =>
      inputs.retainAdmission(f.dir, { ...request, payload: { changed: true } }),
    { code: "REQUEST_CONFLICT" },
  );
  assert.deepEqual(
    inputs.readAdmission(f.dir, { ...request, clientId: "foreign" }),
    { status: "missing" },
  );
});

test("stdio consumes a large project-owned RPC after reader restart and rejects foreign reference", async (t) => {
  const f = fixture(t),
    request = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "execute_python", arguments: { code: "print(1)" } },
    };
  // MCP project scope is explicit and independent of the broker directory.
  const originalCwd = process.cwd();
  process.chdir(f.project);
  t.after(() => process.chdir(originalCwd));
  const job = { ...f.job, request: { cwd: f.project } };
  const output = {
    status: 200,
    raw: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "x".repeat(1100 * 1024) }] },
    }),
  };
  const file = artifacts.responsePath(f.dir, job, "rpc-result.json", true);
  records.durable(file, output);
  const descriptor = object(
    field(artifacts.jobOutputs(f.dir, job), "outputs", "rpc"),
  );
  const restarted = execFileSync(
    process.execPath,
    [
      "-e",
      `
    const { readOwnedResult } = require('./src/queue-response-files');
    const bytes = readOwnedResult(${JSON.stringify(f.dir)}, ${JSON.stringify({ jobId: job.id, cwd: f.project })}, ${JSON.stringify(descriptor["artifact"])});
    process.stdout.write(String(JSON.parse(bytes).raw.length));
  `,
    ],
    { cwd: path.resolve(fixtureDirectory, ".."), encoding: "utf8" },
  );
  assert.equal(Number(restarted), output.raw.length);
  async function run(reference: unknown) {
    const stdin = new PassThrough();
    let text = "";
    const dependencies = {
      stdin,
      stdout: {
        write(value: string) {
          text += value;
        },
      },
      stderr: { write() {} },
      loadConfig: () => ({
        cfg: {
          backend: "addin" as const,
          routing: "queue" as const,
          timeoutMs: 1000,
          headers: {},
        },
      }),
      McpClient: class {
        close() {}
      },
      QueueClient: class {
        dir = f.dir;
        async register() {}
        async submit() {
          return job;
        }
        async wait() {
          return {
            job,
            outputs: {
              rpc: {
                ...descriptor,
                path: "/not/an/allowlist",
                artifact: reference,
              },
            },
          };
        }
      },
    };
    const server: unknown = Reflect.apply(startStdio, undefined, [
      ["--routing", "queue", "--project-directory", f.project],
      dependencies,
    ]);
    const closed = field(server, "closed");
    assert.ok(closed instanceof Promise);
    stdin.end(
      JSON.stringify({
        ...request,
        params: {
          ...request.params,
          arguments: { ...request.params.arguments, persistent: false },
        },
      }) + "\n",
    );
    await closed;
    return object(JSON.parse(text));
  }
  // A second module load simulates a new reader process with no cached broker object.
  delete load.cache[load.resolve("../src/queue-response-files")];
  const good = await run(descriptor["artifact"]);
  assert.equal(
    field(good, "result", "content", 0, "text", "length"),
    1100 * 1024,
  );
  const foreign = await run({
    ...object(descriptor["artifact"]),
    scope: "foreign",
  });
  assert.match(string(field(foreign, "error", "message")), /INVALID_ARTIFACT/);
  assert.equal(foreign["result"], undefined);
});
