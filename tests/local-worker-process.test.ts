import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { launchLocalWorker } from "../packages/node-adapters/src/execution/local-worker-process";
import { createBrokerRecords } from "../packages/node-adapters/src/persistence/broker-records";
import { responsePath } from "../packages/node-adapters/src/persistence/owned-results";
import { createQueueInstance } from "../packages/node-adapters/src/execution/queue-instance";
import * as platform from "../packages/node-adapters/src/config-platform";

const { processBirth } = createQueueInstance(__filename, platform);

function fixture(t: TestContext, wait = false) {
  const dir = fs.mkdtempSync("/tmp/opencode/worker-process-");
  const id = randomUUID();
  const directory = path.join(dir, "jobs", id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const entrypoint = path.join(dir, "worker.cjs");
  fs.writeFileSync(
    entrypoint,
    `
const fs = require("node:fs");
const path = require("node:path");
const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!fs.existsSync(path.join(path.dirname(process.argv[2]), "worker-start.json"))) process.exit(8);
console.log(JSON.stringify({ input, env: process.env }));
console.error("owned stderr");
if (input.request.payload.wait) setInterval(() => {}, 1000);
`,
  );
  const input = {
    intent: {
      id,
      buildHash: "original-build",
      properties: { source: "accepted" },
      deadline: Date.now() + 5000,
      request: {
        kind: "command" as const,
        clientId: "owner",
        requestId: randomUUID(),
        cwd: dir,
        argv: ["never-a-shell"],
        timeoutMs: 5000,
        payload: { wait },
      },
    },
    brokerDirectory: dir,
    entrypoint,
    capability: { jobId: id, token: "owned-token" },
    backend: { backend: "addin", tool: "owned-tool" },
  };
  const identityFailures: string[] = [];
  const ports = {
    records: createBrokerRecords(dir),
    processBirth,
    onIdentityPublicationFailure(code: string) {
      identityFailures.push(code);
    },
  };
  const handles: ReturnType<typeof launchLocalWorker>[] = [];
  t.after(async () => {
    for (const h of handles) h.terminateOwnProcess();
    await Promise.allSettled(handles.map((h) => h.completion));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    input,
    ports,
    directory,
    identityFailures,
    launch() {
      const h = launchLocalWorker(input, ports);
      handles.push(h);
      return h;
    },
    output(name: string) {
      return responsePath(
        dir,
        { id, request: input.intent.request },
        name,
        true,
      );
    },
  };
}

function openDescriptors(file: string) {
  return fs.readdirSync("/proc/self/fd").filter((fd) => {
    try {
      return fs.readlinkSync(`/proc/self/fd/${fd}`) === file;
    } catch {
      return false;
    }
  });
}

test("one owned process receives the exact accepted intent and sanitized capability", async (t) => {
  const f = fixture(t);
  const oldSecret = process.env["FMCAD_UNRELATED_SECRET"];
  const oldNodeOptions = process.env["NODE_OPTIONS"];
  process.env["FMCAD_UNRELATED_SECRET"] = "not-for-worker";
  process.env["NODE_OPTIONS"] = "--trace-warnings";
  t.after(() => {
    for (const [key, old] of [
      ["FMCAD_UNRELATED_SECRET", oldSecret],
      ["NODE_OPTIONS", oldNodeOptions],
    ] as const) {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    }
  });
  const h = f.launch();
  assert.equal(Object.isFrozen(h), true);
  assert.deepEqual(await h.completion, {
    exitCode: 0,
    publicationFailed: false,
  });
  const output = JSON.parse(
    fs.readFileSync(f.output("stdout.txt"), "utf8"),
  ) as {
    input: unknown;
    env: Record<string, string | undefined>;
  };
  assert.deepEqual(output.input, f.input.intent);
  assert.equal(
    output.env["FMCAD_QUEUE_WORKER_TOKEN"],
    f.input.capability.token,
  );
  assert.equal(output.env["FMCAD_QUEUE_WORKER_JOB"], f.input.intent.id);
  assert.equal(output.env["FMCAD_UNRELATED_SECRET"], undefined);
  assert.equal(output.env["NODE_OPTIONS"], undefined);
  const config = JSON.parse(output.env["FMCAD_QUEUE_WORKER_CONFIG"]!) as object;
  assert.partialDeepStrictEqual(config, {
    url: "http://queue.invalid",
    headers: {},
  });
  const snapshot = h.snapshot();
  assert.equal(snapshot.running, false);
  assert.equal(Object.isFrozen(snapshot), true);
  const identity = JSON.parse(
    fs.readFileSync(path.join(f.directory, "worker-identity.json"), "utf8"),
  );
  assert.deepEqual(identity, { pid: snapshot.pid, birth: snapshot.birth });
  for (const name of ["stdout.txt", "stderr.txt"]) {
    assert.equal(fs.statSync(f.output(name)).mode & 0o777, 0o600);
    assert.deepEqual(openDescriptors(f.output(name)), []);
  }
  h.terminateOwnProcess();
  assert.deepEqual(f.identityFailures, []);
});

test("a second output open failure closes the first descriptor and preserves evidence", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.output("stderr.txt"), "previous evidence");
  const h = f.launch();
  await assert.rejects(h.completion, { code: "EEXIST" });
  assert.equal(h.snapshot().pid, null);
  assert.deepEqual(openDescriptors(f.output("stdout.txt")), []);
  assert.equal(
    fs.readFileSync(f.output("stderr.txt"), "utf8"),
    "previous evidence",
  );
  assert.equal(
    fs.readFileSync(path.join(f.directory, "request.json"), "utf8"),
    JSON.stringify(f.input.intent),
  );
  assert.equal(
    fs.existsSync(path.join(f.directory, "worker-start.json")),
    false,
  );
});

test("an immutable request refusal never opens outputs or starts a process", async (t) => {
  const f = fixture(t);
  f.ports.records.createIntent(f.input.intent.id, f.input.intent);
  const bytes = fs.readFileSync(path.join(f.directory, "request.json"));
  const h = f.launch();
  await assert.rejects(h.completion, { code: "EEXIST" });
  assert.equal(h.snapshot().pid, null);
  assert.equal(fs.existsSync(f.output("stdout.txt")), false);
  assert.deepEqual(
    fs.readFileSync(path.join(f.directory, "request.json")),
    bytes,
  );
});

test("intent rejection retains the original cause without an early unhandled rejection", async (t) => {
  const f = fixture(t);
  const failure = Object.assign(new Error("owned intent publication failed"), {
    code: "EIO",
  });
  t.mock.method(f.ports.records, "createIntent", () => {
    throw failure;
  });
  const h = f.launch();
  await setImmediate();
  await assert.rejects(h.completion, (error) => error === failure);
  assert.equal(h.snapshot().pid, null);
  assert.equal(fs.existsSync(f.output("stdout.txt")), false);
});

test("a start-record failure closes both streams without replacing the start evidence", async (t) => {
  const f = fixture(t);
  const start = path.join(f.directory, "worker-start.json");
  fs.writeFileSync(start, "original start evidence");
  const h = f.launch();
  assert.deepEqual(await h.completion, {
    exitCode: 1,
    publicationFailed: true,
  });
  assert.equal(h.snapshot().pid, null);
  assert.equal(fs.readFileSync(start, "utf8"), "original start evidence");
  for (const name of ["stdout.txt", "stderr.txt"])
    assert.deepEqual(openDescriptors(f.output(name)), []);
});

test("sync and async spawn failure resolve locally, unlike intent/output-open failure", async (t) => {
  for (const mode of ["throw", "event"]) {
    const f = fixture(t);
    const original = childProcess.spawn;
    const failure = new Error("injected spawn failure");
    const mock = t.mock.method(
      childProcess,
      "spawn",
      (...args: Parameters<typeof childProcess.spawn>) => {
        if (mode === "throw") throw failure;
        return original("/no-such-owned-worker-executable", args[1], args[2]);
      },
    );
    const h = f.launch();
    const result = await h.completion;
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicationFailed, mode === "throw");
    mock.mock.restore();
    assert.equal(h.snapshot().running, false);
    for (const name of ["stdout.txt", "stderr.txt"])
      assert.deepEqual(openDescriptors(f.output(name)), []);
    assert.equal(fs.existsSync(path.join(f.directory, "request.json")), true);
  }
});

test("identity publication failure notifies the owner and kills only that process", async (t) => {
  const f = fixture(t, true);
  fs.writeFileSync(
    path.join(f.directory, "worker-identity.json"),
    "original evidence",
  );
  const h = f.launch();
  const result = await h.completion;
  assert.equal(result.publicationFailed, true);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(f.identityFailures, ["EEXIST"]);
  assert.equal(
    fs.readFileSync(path.join(f.directory, "worker-identity.json"), "utf8"),
    "original evidence",
  );
  assert.equal(h.snapshot().running, false);
});

test("termination and completion do not expose or settle another worker", async (t) => {
  const first = fixture(t, true),
    second = fixture(t, true);
  const a = first.launch(),
    b = second.launch();
  while (!a.snapshot().birth || !b.snapshot().birth) await setImmediate();
  const before = a.snapshot();
  a.terminateOwnProcess();
  assert.equal((await a.completion).exitCode, 1);
  assert.equal(
    before.running,
    true,
    "earlier diagnostic snapshot is immutable",
  );
  assert.equal(b.snapshot().running, true);
  process.kill(b.snapshot().pid!, 0);
  b.terminateOwnProcess();
  await b.completion;
});

test("a stream sync or close fault still closes both owned descriptors", async (t) => {
  for (const mode of ["sync", "close"]) {
    const f = fixture(t);
    const originalSync = fs.fsyncSync,
      originalClose = fs.closeSync;
    const synced: number[] = [];
    const isOutput = (fd: number) => {
      try {
        return (
          fs.readlinkSync(`/proc/self/fd/${fd}`) === f.output("stdout.txt")
        );
      } catch {
        return false;
      }
    };
    const sync = t.mock.method(fs, "fsyncSync", (fd: number) => {
      synced.push(fd);
      if (mode === "sync" && isOutput(fd))
        throw new Error("injected fsync failure");
      return originalSync(fd);
    });
    const close = t.mock.method(fs, "closeSync", (fd: number) => {
      const fail = mode === "close" && isOutput(fd);
      originalClose(fd);
      if (fail) throw new Error("injected close failure after close");
    });
    const result = await f.launch().completion;
    sync.mock.restore();
    close.mock.restore();
    assert.equal(result.publicationFailed, true);
    assert.ok(synced.length >= 2);
    for (const name of ["stdout.txt", "stderr.txt"])
      assert.deepEqual(openDescriptors(f.output(name)), []);
  }
});

test("a failed identity notification cannot strand process completion", async (t) => {
  const f = fixture(t, true);
  f.ports.processBirth = () => {
    throw Object.assign(new Error("identity unavailable"), { code: "EIO" });
  };
  f.ports.onIdentityPublicationFailure = () => {
    throw new Error("owner publication failed");
  };
  const h = f.launch();
  assert.deepEqual(await h.completion, {
    exitCode: 1,
    publicationFailed: true,
  });
  assert.equal(h.snapshot().running, false);
  assert.deepEqual(openDescriptors(f.output("stdout.txt")), []);
});

test("an already exited process identity is a local publication failure, not settlement", async (t) => {
  const f = fixture(t);
  f.ports.processBirth = () => {
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  };
  const h = f.launch();
  assert.deepEqual(await h.completion, {
    exitCode: 0,
    publicationFailed: true,
  });
  assert.deepEqual(
    f.identityFailures,
    [],
    "preserve the existing short-process exception",
  );
});
