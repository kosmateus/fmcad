import type { Client } from "../src/queue-broker-ports.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import { object, field, string } from "./modeling-unit-test-support.js";
const fixtureDirectory = path.join(process.cwd(), "tests");
const load = createRequire(
  path.join(fixtureDirectory, "execution-store-integration.test.ts"),
);
const restorePlatform = (
  load("./fixtures/fake-wsl-platform.cjs") as () => () => void
)();
test.after(restorePlatform);
const { serve } = load(
  "../src/queue-broker",
) as typeof import("../src/queue-broker.js");
const { request } = load(
  "../src/queue-connection",
) as typeof import("../src/entrypoints/queue-connection.js");
const { QueueState } = load(
  "../src/queue-state",
) as typeof import("../src/queue-state.js");
const { readOwnedResult } = load(
  "../src/queue-response-files",
) as typeof import("../packages/node-adapters/src/persistence/owned-results.js");
const { readAcceptedInput } = load(
  "../src/dist/node-adapters/persistence/accepted-inputs",
) as typeof import("../packages/node-adapters/src/persistence/accepted-inputs.js");

function acceptedBytes(dir: string, reference: unknown): Buffer {
  // The persisted descriptor is untrusted; let the actual reader validate it.
  const result: unknown = Reflect.apply(readAcceptedInput, undefined, [
    dir,
    reference,
  ]);
  assert.equal(field(result, "status"), "available");
  const bytes = field(result, "bytes");
  assert.ok(Buffer.isBuffer(bytes));
  return bytes;
}

function fixture(t: TestContext, cleanup = true) {
  const root = fs.mkdtempSync("/tmp/opencode/execution-integrated-");
  if (cleanup) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "queue"),
    project = path.join(root, "project");
  fs.mkdirSync(path.join(project, ".cad"), { recursive: true });
  return { root, dir, project };
}

test("broker large project RPC/provenance survive restart; foreign owner and symlink fail closed", async (t) => {
  const f = fixture(t, false);
  let sends = 0;
  let broker: Awaited<ReturnType<typeof serve>> | null;
  const identity = {
    pid: 99,
    birth: "mock:99",
    version: "mock",
    activeCommand: "SelectCommand",
    documents: [],
    documentState: { status: "metadata-only" },
  };
  const physical: Client = {
    _openSession: async () => assert.fail("unexpected SDK session"),
    listTools: async () => assert.fail("unexpected tool discovery"),
    executeUiGuardedScript: async () => assert.fail("unexpected UI mutation"),
    server: { timeoutMs: 3000 },
    _parse: JSON.parse,
    async _post(payload) {
      sends++;
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { data: "x".repeat(1100 * 1024) },
        }),
      };
    },
    async callTool() {
      return {
        failed: false,
        text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(identity),
      };
    },
  };
  const start = () =>
    serve(
      { backend: "addin", timeoutMs: 3000 },
      {
        dir: f.dir,
        confirmOwnership: true,
        createBackend: () => physical,
        pollMs: 5,
      },
    );
  broker = await start();
  t.after(async () => {
    try {
      if (broker) await broker.close();
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
  const auth = { clientId: "owner", clientToken: "secret-owner" },
    foreign = { clientId: "foreign", clientToken: "secret-foreign" };
  await request(f.dir, { action: "register", ...auth });
  await request(f.dir, { action: "register", ...foreign });
  const call = (action: string, values: Record<string, unknown> = {}) =>
    request(f.dir, { action, auth, ...values });
  const source = path.join(f.project, "source.py");
  fs.writeFileSync(source, "accepted-source\r\n");
  const input = {
    kind: "rpc",
    requestId: randomUUID(),
    timeoutMs: 3000,
    cwd: f.project,
    payload: { jsonrpc: "2.0", id: 1, method: "ping" },
    inputFiles: [
      {
        path: source,
        sha256: createHash("sha256")
          .update("accepted-source\r\n")
          .digest("hex"),
      },
    ],
  };
  const job = await call("submit", { request: input });
  let result: unknown;
  for (let i = 0; i < 200; i++) {
    result = await call("result", { jobId: field(job, "id") });
    if (field(result, "job", "state") === "succeeded") break;
    assert.equal(
      ["failed", "needs_reconciliation"].includes(
        string(field(result, "job", "state")),
      ),
      false,
      JSON.stringify(field(result, "job")),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(field(result, "job", "state"), "succeeded");
  assert.equal(
    field(result, "outputs", "rpc", "artifact", "storage"),
    "project",
  );
  assert.equal(field(result, "provenance", "status"), "available");
  assert.deepEqual(
    JSON.parse(
      acceptedBytes(f.dir, field(result, "provenance", "inputs", 0)).toString(
        "utf8",
      ),
    ),
    input.payload,
  );
  fs.writeFileSync(source, "current-source");
  await broker.close();
  broker = null;
  broker = await start();
  const after = await call("result", { jobId: field(job, "id") });
  assert.equal(
    acceptedBytes(f.dir, field(after, "provenance", "inputs", 1)).toString(),
    "accepted-source\r\n",
  );
  assert.deepEqual(
    field(after, "outputs", "rpc", "artifact"),
    field(result, "outputs", "rpc", "artifact"),
  );
  const bytes: unknown = Reflect.apply(readOwnedResult, undefined, [
    f.dir,
    { jobId: field(job, "id"), cwd: f.project },
    field(after, "outputs", "rpc", "artifact"),
  ]);
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(
    field(
      JSON.parse(string(field(JSON.parse(bytes.toString("utf8")), "raw"))),
      "result",
      "data",
      "length",
    ),
    1100 * 1024,
  );
  await assert.rejects(
    request(f.dir, {
      action: "result",
      auth: foreign,
      jobId: field(job, "id"),
    }),
    /Only the submitting client/,
  );
  const retried = await call("submit", { request: input });
  assert.equal(field(retried, "id"), field(job, "id"));
  assert.equal(sends, 1);
  // Historical records without provenance must not capture today's input on retry.
  fs.rmSync(path.join(f.dir, "admissions"), { recursive: true });
  assert.equal(
    field(await call("submit", { request: input }), "id"),
    field(job, "id"),
  );
  assert.deepEqual(
    field(await call("result", { jobId: field(job, "id") }), "provenance"),
    { status: "missing" },
  );
  fs.unlinkSync(string(field(after, "outputs", "rpc", "path")));
  fs.symlinkSync("/etc/passwd", string(field(after, "outputs", "rpc", "path")));
  await assert.rejects(
    call("result", { jobId: field(job, "id") }),
    /ELOOP|symbolic|symlink/,
  );
  assert.equal(sends, 1, "artifact faults never replay execution");
});

test("integrated queue commit failure preserves unfinished receipt and blocks restart", (t) => {
  const f = fixture(t),
    state = new QueueState(f.dir);
  const job = state.submit({
    clientId: "owner",
    requestId: "once",
    kind: "rpc",
    timeoutMs: 1000,
    payload: {},
  });
  state.next();
  const receipt = path.join(f.dir, "receipt.json");
  fs.writeFileSync(receipt, '{"terminal":false}');
  const original = fs.renameSync;
  fs.renameSync = (...args) => {
    if (args[1] === state.file)
      throw Object.assign(new Error("injected full disk"), { code: "ENOSPC" });
    return original(...args);
  };
  try {
    assert.throws(() => state.finish(string(field(job, "id"))), {
      code: "STORAGE_UNAVAILABLE",
    });
  } finally {
    fs.renameSync = original;
  }
  assert.throws(() => state.status(string(field(job, "id"))), {
    code: "STORAGE_UNAVAILABLE",
  });
  assert.notEqual(
    field(state.data, "jobs", string(field(job, "id")), "state"),
    "succeeded",
  );
  assert.throws(() => state.next(), { code: "STORAGE_UNAVAILABLE" });
  assert.equal(fs.readFileSync(receipt, "utf8"), '{"terminal":false}');
  assert.throws(() => new QueueState(f.dir), { code: "STORAGE_UNAVAILABLE" });
  assert.equal(
    field(
      JSON.parse(fs.readFileSync(state.file, "utf8")),
      "jobs",
      string(field(job, "id")),
      "state",
    ),
    "running",
  );
});

test("version-1 unfinished snapshots restore unknown, corrupt/truncated/unknown versions never succeed", (t) => {
  const f = fixture(t),
    state = new QueueState(f.dir);
  const job = state.submit({
    clientId: "owner",
    requestId: "once",
    kind: "rpc",
    timeoutMs: 1000,
    payload: {},
  });
  state.next();
  const restored = new QueueState(f.dir);
  assert.equal(
    field(restored.status(string(field(job, "id"))), "state"),
    "needs_reconciliation",
  );
  assert.equal(restored.next(), null);
  const snapshot = object(JSON.parse(fs.readFileSync(state.file, "utf8")));
  object(snapshot)["version"] = 999;
  fs.writeFileSync(state.file, JSON.stringify(snapshot));
  assert.throws(() => new QueueState(f.dir), { code: "CORRUPT_STATE" });
  fs.writeFileSync(state.file, '{"version":1');
  assert.throws(() => new QueueState(f.dir), { code: "CORRUPT_STATE" });
});
