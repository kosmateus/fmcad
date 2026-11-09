import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const load = createRequire(path.resolve("tests/queue-probe-recovery.test.js"));
const qi = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { QueueState } = load(
  "../src/queue-state",
) as typeof import("../src/queue-state");
type ProbeOnlyClient = {
  server: { timeoutMs: number };
  _post(): never;
  _parse(text: string): unknown;
  callTool(value: {
    object: { script: string };
  }): Promise<{ failed: boolean; text: string }>;
};
const { serve, brokerConfigHash } = load("../src/queue-broker") as {
  brokerConfigHash: typeof import("../src/queue-broker").brokerConfigHash;
  serve(
    cfg: import("../src/queue-broker-ports").Config,
    options: Omit<
      import("../src/queue-broker-ports").Options,
      "createBackend"
    > & { createBackend(): ProbeOnlyClient },
  ): ReturnType<typeof import("../src/queue-broker").serve>;
};
const { request } = load(
  "../src/queue-connection",
) as typeof import("../src/entrypoints/queue-connection");

test("failed terminal recovery probe can be replaced; unresolved, mismatched and busy probes cannot", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-"));
  let broker: Awaited<ReturnType<typeof serve>> | undefined;
  t.after(async () => {
    await broker?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cfg = { backend: "addin", timeoutMs: 1000 };
  const buildHash = qi.buildHash();
  const instance = {
    pid: 123,
    birth: "test:1",
    version: "test",
    activeCommand: "SelectCommand",
    documents: [],
  };
  const state = new QueueState(dir);
  const job = state.submit({
    kind: "command",
    requestId: randomUUID(),
    clientId: "owner",
    timeoutMs: 1000,
    argv: ["run", "original.py"],
    cwd: dir,
  });
  state.next();
  state.markDispatch(text(job["id"]), { rpcCount: 1, completedCount: 1 });
  state.block(text(job["id"]), "INSTANCE_UNAVAILABLE");
  const directory = path.join(dir, "jobs", text(job["id"]));
  fs.mkdirSync(directory, { recursive: true });
  const binding = {
    jobId: text(job["id"]),
    rpcId: randomUUID(),
    buildHash,
    requestHash: "original",
  };
  const originalReceipt = path.join(directory, `remote-${binding.rpcId}.json`);
  const completed = {
    ...binding,
    terminal: true,
    outcome: "succeeded",
    instance,
  };
  qi.durable(originalReceipt, completed);
  qi.durable(path.join(directory, `rpc-${binding.rpcId}.json`), {
    binding,
    instance,
    terminal: true,
    method: "tools/call",
    receipt: originalReceipt,
    remoteReceipt: completed,
    request: { method: "tools/call", id: 1 },
    response: {
      status: 200,
      raw: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
    },
  });
  qi.durable(path.join(directory, "worker-result.json"), {
    jobId: text(job["id"]),
    code: 0,
    terminal: true,
  });
  qi.durable(path.join(dir, "instance.json"), {
    configHash: brokerConfigHash(cfg),
    buildHash,
    instance,
  });
  const recoveryBinding = {
    jobId: text(job["id"]),
    rpcId: randomUUID(),
    requestHash: "probe",
    buildHash,
  };
  const receipt = path.join(
    directory,
    `reconcile-${recoveryBinding.rpcId}.receipt.json`,
  );
  qi.durable(path.join(directory, "reconcile-probe.json"), {
    binding: recoveryBinding,
    instance,
    receipt,
  });
  let calls = 0;
  const client = {
    server: { timeoutMs: 1000 },
    _post() {
      throw Error("No product replay allowed");
    },
    _parse: JSON.parse,
    async callTool(value: { object: { script: string } }) {
      calls++;
      const script = value.object.script;
      assert.match(script, /FMCAD_QUEUE_INSTANCE/);
      const match = script.match(
        /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/,
      );
      assert.ok(match);
      const freshBinding = record(JSON.parse(JSON.parse(match[1]!)));
      qi.durable(
        path.join(directory, `reconcile-${freshBinding["rpcId"]}.receipt.json`),
        { ...freshBinding, terminal: true, outcome: "succeeded", instance },
      );
      return {
        failed: false,
        text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance),
      };
    },
  };
  broker = await serve(cfg, {
    dir,
    confirmOwnership: true,
    createBackend: () => client,
    nativePath: (file) => file,
  });
  await request(dir, {
    action: "register",
    clientId: "owner",
    clientToken: "secret",
  });
  const reconcile = () =>
    request(dir, {
      action: "reconcile",
      jobId: text(job["id"]),
      auth: { clientId: "owner", clientToken: "secret" },
    });
  await assert.rejects(reconcile(), { code: "RECEIPT_UNAVAILABLE" });
  qi.durable(receipt, {
    ...recoveryBinding,
    jobId: "wrong",
    terminal: true,
    outcome: "failed",
    instance,
  });
  await assert.rejects(reconcile(), { code: "RECEIPT_MISMATCH" });
  qi.durable(receipt, {
    ...recoveryBinding,
    terminal: true,
    outcome: "failed",
    instance: { ...instance, activeCommand: "NativeCommand" },
  });
  await assert.rejects(reconcile(), { code: "NATIVE_RECEIPT_REQUIRED" });
  assert.equal(calls, 0);
  qi.durable(receipt, {
    ...recoveryBinding,
    terminal: true,
    outcome: "failed",
    instance,
  });
  fs.unlinkSync(originalReceipt);
  // The original terminal journal embeds the receipt, so removing that optional
  // duplicate does not change the proven completion. Pending journals below do.
  const rpcFile = path.join(directory, `rpc-${binding.rpcId}.json`);
  const terminalRecord = record(qi.readJson(rpcFile));
  qi.durable(rpcFile, { ...terminalRecord, terminal: false });
  await assert.rejects(reconcile(), { code: "RECEIPT_UNAVAILABLE" });
  assert.equal(calls, 0);
  qi.durable(originalReceipt, completed);
  qi.durable(rpcFile, terminalRecord);
  const result = record(await reconcile());
  assert.equal(result["state"], "succeeded");
  assert.equal(calls, 1);
  assert.equal(broker.status().held, null);
  assert.ok(
    fs.existsSync(
      path.join(directory, `reconcile-probe-${recoveryBinding.rpcId}.json`),
    ),
  );
  assert.equal(record(qi.readJson(receipt))["outcome"], "failed");
});

test("probe diagnostics retain backend failure and restore timeout", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const diagnosticPath = path.join(dir, "probe.json");
  const client = {
    server: { timeoutMs: 20000 },
    async callTool() {
      return { failed: true, text: "RuntimeError: dataFile getter failed" };
    },
  };
  await assert.rejects(qi.probe(client, { diagnosticPath }), {
    code: "INSTANCE_UNAVAILABLE",
  });
  assert.match(
    text(record(qi.readJson(diagnosticPath))["text"]),
    /dataFile getter failed/,
  );
  assert.equal(client.server.timeoutMs, 20000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("temporary-file metadata failure does not hide other documents or validate the damaged target", async (t) => {
  const originalRead = fs.readFileSync;
  t.mock.method(
    fs,
    "readFileSync",
    function (this: typeof fs, ...args: Parameters<typeof fs.readFileSync>) {
      const [file] = args;
      const name = String(file).replaceAll("\\", "/");
      assert.equal(
        /\/assets\/(cad\/identity|queue_document)\.py$/.test(name),
        false,
        "broker document probe must not read legacy asset copies",
      );
      return originalRead.apply(this, args);
    },
  );
  const runtime = load("../src/dist/config-platform").resolveRuntimePaths({
    anchor: load.resolve("../src/queue-instance"),
  }).runtime;
  const canonical = load(
    "../src/dist/python/document-probe",
  ).queueDocumentSnapshotSource(runtime);
  let stub = `import sys, types
class Doc:
    def __init__(self, name, broken=False):
        self.creationId=name; self.name=name; self.isSaved=True; self.isModified=broken; self.broken=broken
    @property
    def dataFile(self):
        if self.broken: raise RuntimeError('3 : Failed to get temporary file')
        return types.SimpleNamespace(id='file-'+self.name)
docs=[Doc('broken', True), Doc('healthy')]
app=types.SimpleNamespace(version='test', userInterface=types.SimpleNamespace(activeCommand='SelectCommand'),
    documents=types.SimpleNamespace(count=len(docs), item=lambda i: docs[i]))
core=types.ModuleType('adsk.core'); core.Application=types.SimpleNamespace(get=lambda:app)
adsk=types.ModuleType('adsk'); adsk.core=core
sys.modules['adsk']=adsk; sys.modules['adsk.core']=core
`;
  const client = {
    server: { timeoutMs: 20000 },
    async callTool(value: { object: { script: string } }) {
      assert.ok(
        value.object.script.startsWith(canonical),
        "compose canonical identity and queue helpers once before the wrapper",
      );
      assert.equal(
        (value.object.script.match(/^def _document_data_file\(/gm) || [])
          .length,
        1,
      );
      assert.equal(
        (value.object.script.match(/^def _qd_capture\(/gm) || []).length,
        1,
      );
      const output = spawnSync(
        "python3",
        ["-c", stub + value.object.script + "\nrun(None)"],
        { encoding: "utf8" },
      );
      return {
        failed: output.status !== 0,
        text: output.stdout + output.stderr,
      };
    },
  };
  const instance = await qi.probe(client);
  assert.equal(instance.documents.length, 2);
  assert.deepEqual(instance.documents[0], {
    id: "broken",
    fileId: null,
    isSaved: true,
    isModified: true,
    dataFileError: {
      type: "RuntimeError",
      message: "3 : Failed to get temporary file",
    },
  });
  assert.equal(record(instance.documents[1])["fileId"], "file-healthy");
  const pinned = await qi.probe(client, {
    documentSelector: { creationId: "broken", fileId: "claimed-file" },
  });
  assert.equal(field(field(pinned, "documentState"), "status"), "unavailable");
  assert.match(
    text(field(field(field(pinned, "documentState"), "error"), "message")),
    /Failed to get temporary file/,
  );
  stub = stub.replace("Failed to get temporary file", "Unexpected SDK error");
  await assert.rejects(qi.probe(client), { code: "INSTANCE_UNAVAILABLE" });
});

test("Python receipt retains original exception and traceback without swallowing it", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receipt = path.join(dir, "receipt.json");
  const script = qi.wrapScript(
    "raise ValueError('document metadata unavailable')",
    false,
    receipt,
    { jobId: "test" },
    { mapPath: (file) => file },
  );
  // Linux offline SDK stub; no Fusion client, server or real document.
  const body =
    `import sys, types\ncore=types.ModuleType('adsk.core')\ncore.Application=types.SimpleNamespace(get=lambda: types.SimpleNamespace(version='test', userInterface=types.SimpleNamespace(activeCommand='SelectCommand')))\nadsk=types.ModuleType('adsk'); adsk.core=core\nsys.modules['adsk']=adsk; sys.modules['adsk.core']=core\n` +
    script;
  const output = spawnSync("python3", ["-c", body], { encoding: "utf8" });
  assert.notEqual(output.status, 0);
  const value = record(qi.readJson(receipt));
  assert.equal(value["outcome"], "failed");
  assert.equal(record(value["error"])["type"], "ValueError");
  assert.match(
    text(record(value["error"])["traceback"]),
    /document metadata unavailable/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function field(value: unknown, key: string): unknown {
  return record(value)[key];
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
