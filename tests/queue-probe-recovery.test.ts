import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
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
  let broker: Awaited<ReturnType<typeof serve>> | undefined = undefined;
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

const { createBrokerTransport } = load(
  "../packages/node-adapters/dist/fusion-transport/broker.js",
) as typeof import("../packages/node-adapters/src/fusion-transport/broker");
type ProbeClient =
  import("../packages/node-adapters/src/execution/queue-instance").ProbeClient;

async function mcpFixture(
  t: import("node:test").TestContext,
  reply: (id: number) => Record<string, unknown>,
) {
  let rawResponse = "";
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.method === "initialize") {
        response.setHeader("Mcp-Session-Id", "probe-response-test");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-11-25",
              serverInfo: { name: "fixture", version: "1" },
            },
          }),
        );
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202);
        response.end();
        return;
      }
      rawResponse = JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        ...reply(message.id ?? 2),
      });
      response.end(rawResponse);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const physical = createBrokerTransport(
    {
      backend: "mcp",
      transport: "http",
      url: `http://127.0.0.1:${address.port}/mcp`,
      tool: "fusion_mcp_execute",
      timeoutMs: 1000,
      protocolVersion: "2025-11-25",
    },
    {
      version: "test",
      bridgeSource: () => "",
      requestTimeout: (serverConfig) => serverConfig.timeoutMs ?? 1000,
    },
  );
  const client: ProbeClient = {
    server: { timeoutMs: 1000 },
    prepareCallTool: (args, tool, manifest) =>
      physical.prepareCallTool({ ...args }, tool, manifest),
    callTool: (args, tool) => physical.callTool({ ...args }, tool),
  };
  return { client, raw: () => rawResponse };
}

function probeMarker(identity: Record<string, unknown>) {
  return `FMCAD_QUEUE_INSTANCE ${JSON.stringify(identity)}`;
}

function readDiagnostic(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

test("instance probe preserves raw MCP response and reads structured stdout", async (t) => {
  const identity = {
    pid: 1420,
    birth: "probe:1420",
    version: "fixture",
    documents: [],
  };
  const contentText = JSON.stringify({ success: true, message: "" });
  const structuredContent = {
    success: true,
    stdout: probeMarker(identity),
    stderr: "",
  };
  const { client, raw } = await mcpFixture(t, () => ({
    result: {
      content: [{ type: "text", text: contentText }],
      structuredContent,
      isError: false,
    },
  }));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "instance-probe-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const diagnosticPath = path.join(directory, "preflight-result.json");

  const probe = await qi.prepareProbe(client, {
    diagnosticPath,
    requireIdle: false,
  });
  assert.deepEqual(await probe(), identity);

  const diagnostic = readDiagnostic(diagnosticPath);
  assert.equal(diagnostic["text"], probeMarker(identity));
  assert.equal(diagnostic["transportText"], contentText);
  assert.equal(diagnostic["rawResponse"], raw());
  assert.deepEqual(diagnostic["data"], structuredContent);
});

test("instance probe rejects conflicting identities in content and structured stdout", async (t) => {
  const contentIdentity = {
    pid: 1420,
    birth: "probe:1420",
    version: "fixture",
    documents: [],
  };
  const structuredIdentity = {
    ...contentIdentity,
    pid: 1421,
    birth: "probe:1421",
  };
  const structuredContent = { stdout: probeMarker(structuredIdentity) };
  const { client, raw } = await mcpFixture(t, () => ({
    result: {
      content: [{ type: "text", text: probeMarker(contentIdentity) }],
      structuredContent,
    },
  }));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "instance-probe-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const diagnosticPath = path.join(directory, "preflight-result.json");
  let observed = false;

  const probe = await qi.prepareProbe(client, {
    diagnosticPath,
    requireIdle: false,
    onObservation: () => (observed = true),
  });
  await assert.rejects(probe(), {
    code: "INSTANCE_UNAVAILABLE",
    message: "Conflicting Fusion instance identities",
  });
  assert.equal(observed, false);
  assert.equal(readDiagnostic(diagnosticPath)["rawResponse"], raw());
});

test("instance probe retains the raw response but does not accept empty structured stdout", async (t) => {
  const structuredContent = { success: true, stdout: "", stderr: "" };
  const { client, raw } = await mcpFixture(t, () => ({
    result: { content: [], structuredContent },
  }));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "instance-probe-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const diagnosticPath = path.join(directory, "preflight-result.json");

  const probe = await qi.prepareProbe(client, {
    diagnosticPath,
    requireIdle: false,
  });
  await assert.rejects(probe(), {
    code: "INSTANCE_UNAVAILABLE",
    message: "Fusion instance probe returned no identity",
  });
  const diagnostic = readDiagnostic(diagnosticPath);
  assert.equal(diagnostic["rawResponse"], raw());
  assert.deepEqual(diagnostic["data"], structuredContent);
});

test("instance probe retains native JSON-RPC error details and raw response", async (t) => {
  const nativeError = { code: -32000, message: "fixture failure" };
  const { client, raw } = await mcpFixture(t, () => ({ error: nativeError }));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "instance-probe-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const diagnosticPath = path.join(directory, "preflight-result.json");

  const probe = await qi.prepareProbe(client, {
    diagnosticPath,
    requireIdle: false,
  });
  await assert.rejects(probe(), { code: "MCP_ERROR" });
  const diagnostic = readDiagnostic(diagnosticPath);
  assert.equal(diagnostic["rawResponse"], raw());
  assert.deepEqual(diagnostic["nativeError"], nativeError);
});

type BoundProbeFixtureOptions = {
  removeReceipt?: boolean;
  mutateReceipt?: (receipt: Record<string, unknown>) => Record<string, unknown>;
  wireText?: (identity: Record<string, unknown>) => string;
};

async function boundProbeFixture(
  t: import("node:test").TestContext,
  options: BoundProbeFixtureOptions = {},
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bound-probe-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const receiptPath = path.join(directory, "startup.receipt.json");
  const diagnosticPath = path.join(directory, "preflight-result.json");
  const atomicWritesPath = path.join(directory, "atomic-writes.jsonl");
  const binding = {
    brokerNonce: "probe-nonce-1",
    ownerPid: 42,
    ownerBirth: "owner:42",
    buildHash: "a".repeat(64),
    stage: "startup",
  };
  const rawResponse = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [
        { type: "text", text: JSON.stringify({ message: "", success: true }) },
      ],
    },
  });
  let calls = 0;
  const client: ProbeClient = {
    server: { timeoutMs: 1000 },
    async callTool(args) {
      calls++;
      const python = `import json, os, sys, types
_target = ${JSON.stringify(receiptPath)}
_events = ${JSON.stringify(atomicWritesPath)}
_replace = os.replace
def _record_replace(source, target):
    if target == _target:
        with open(source, encoding='utf-8') as stream:
            record = json.load(stream)
        with open(_events, 'a', encoding='utf-8') as stream:
            stream.write(json.dumps(record) + '\\n')
    return _replace(source, target)
os.replace = _record_replace
class Doc:
    creationId = 'doc-1'
    isSaved = True
    isModified = False
    dataFile = types.SimpleNamespace(id='file-1')
documents = [Doc()]
app = types.SimpleNamespace(version='fixture', activeDocument=documents[0],
    userInterface=types.SimpleNamespace(activeCommand='SelectCommand'),
    documents=types.SimpleNamespace(count=1, item=lambda index: documents[index]))
core = types.ModuleType('adsk.core')
core.Application = types.SimpleNamespace(get=lambda: app)
adsk = types.ModuleType('adsk')
adsk.core = core
sys.modules['adsk'] = adsk
sys.modules['adsk.core'] = core
`;
      const executed = spawnSync(
        "python3",
        ["-c", python + args.object.script + "\nrun(None)\n"],
        { encoding: "utf8" },
      );
      assert.equal(
        executed.status,
        0,
        `offline receipt wrapper failed: ${executed.stderr}`,
      );
      let receipt: Record<string, unknown>;
      if (options.removeReceipt) {
        fs.unlinkSync(receiptPath);
        receipt = {};
      } else {
        receipt = record(qi.readJson(receiptPath));
      }
      if (options.mutateReceipt && !options.removeReceipt)
        receipt = options.mutateReceipt(receipt);
      if (options.mutateReceipt && !options.removeReceipt)
        qi.durable(receiptPath, receipt);
      const observation = recordOrEmpty(receipt["probeObservation"]);
      const identity = recordOrEmpty(observation["identity"]);
      const textValue = options.wireText
        ? options.wireText(identity)
        : JSON.stringify({ message: "", success: true });
      return {
        failed: false,
        text: textValue,
        data: { message: "", success: true },
        rawResponse,
      };
    },
  };
  const probe = await qi.prepareProbe(client, {
    receiptPath,
    binding,
    mapPath: (file) => file,
    diagnosticPath,
    requireIdle: false,
  });
  return {
    binding,
    calls: () => calls,
    receiptPath,
    diagnosticPath,
    atomicWritesPath,
    probe,
  };
}

test("bound instance probe accepts wire-empty receipt observation written before terminal", async (t) => {
  const fixture = await boundProbeFixture(t);
  const identity = record(await fixture.probe());
  const receipt = record(qi.readJson(fixture.receiptPath));
  assert.equal(typeof identity["pid"], "number");
  assert.ok((identity["pid"] as number) > 0);
  assert.equal(identity["version"], "fixture");
  assert.deepEqual(identity["documents"], [
    {
      id: "doc-1",
      fileId: "file-1",
      isSaved: true,
      isModified: false,
    },
  ]);
  assert.equal(receipt["stage"], fixture.binding.stage);
  assert.equal(receipt["terminal"], true);
  assert.equal(receipt["outcome"], "succeeded");
  assert.deepEqual(receipt["probeObservation"], {
    schema: "fmcad-instance-probe-v1",
    identity,
  });
  const writes = fs
    .readFileSync(fixture.atomicWritesPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(writes.length, 2);
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(fixture.binding).map((key) => [key, writes[0]![key]]),
    ),
    fixture.binding,
  );
  assert.equal(writes[0]!["terminal"], false);
  assert.equal(writes[0]!["stage"], "startup");
  assert.equal(
    record(writes[0]!["probeObservation"])["schema"],
    "fmcad-instance-probe-v1",
  );
  assert.equal(writes[1]!["terminal"], true);
  const diagnostic = readDiagnostic(fixture.diagnosticPath);
  assert.equal(typeof diagnostic["rawResponse"], "string");
  assert.ok((diagnostic["rawResponse"] as string).length > 0);
  assert.equal(diagnostic["wireMarkerPresent"], false);
  assert.equal(diagnostic["wireStdoutPresent"], false);
  assert.equal(diagnostic["observationSource"], "bound-terminal-receipt");
  assert.equal(diagnostic["receiptBindingVerified"], true);
  assert.equal(diagnostic["receiptOutcome"], "succeeded");
  assert.equal(fixture.calls(), 1);
});

for (const [name, mutateReceipt] of [
  [
    "a partial identity",
    (receipt: Record<string, unknown>) => {
      const observation = record(receipt["probeObservation"]);
      const identity = { ...record(observation["identity"]) };
      delete identity["documents"];
      return {
        ...receipt,
        probeObservation: { ...observation, identity },
      };
    },
  ],
  [
    "a foreign stage binding",
    (receipt: Record<string, unknown>) => ({ ...receipt, stage: "preflight" }),
  ],
  [
    "an unbound receipt field",
    (receipt: Record<string, unknown>) => ({ ...receipt, staleNonce: "old" }),
  ],
  [
    "a nonterminal observation without terminal receipt",
    (receipt: Record<string, unknown>) => ({
      ...receipt,
      terminal: false,
      outcome: undefined,
      instance: undefined,
    }),
  ],
  [
    "a failed terminal receipt",
    (receipt: Record<string, unknown>) => ({ ...receipt, outcome: "failed" }),
  ],
  [
    "a receipt for another process identity",
    (receipt: Record<string, unknown>) => ({
      ...receipt,
      instance: { ...record(receipt["instance"]), pid: -1 },
    }),
  ],
] as const) {
  test(`bound instance probe rejects ${name}`, async (t) => {
    const fixture = await boundProbeFixture(t, { mutateReceipt });
    await assert.rejects(fixture.probe(), { code: "INSTANCE_UNAVAILABLE" });
    const diagnostic = readDiagnostic(fixture.diagnosticPath);
    assert.equal(diagnostic["observationSource"], null);
  });
}

test("bound instance probe rejects a missing terminal receipt", async (t) => {
  const fixture = await boundProbeFixture(t, { removeReceipt: true });
  await assert.rejects(fixture.probe(), { code: "INSTANCE_UNAVAILABLE" });
  assert.equal(
    readDiagnostic(fixture.diagnosticPath)["receiptBindingVerified"],
    false,
  );
});

test("bound instance probe refuses a stale receipt path before dispatch", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "bound-probe-stale-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const receiptPath = path.join(directory, "startup.receipt.json");
  const diagnosticPath = path.join(directory, "preflight-result.json");
  const binding = {
    brokerNonce: "probe-nonce-1",
    ownerPid: 42,
    ownerBirth: "owner:42",
    buildHash: "a".repeat(64),
    stage: "startup",
  };
  const prior = { ...binding, terminal: true, outcome: "succeeded" };
  qi.durable(receiptPath, prior);
  let calls = 0;
  const client: ProbeClient = {
    server: { timeoutMs: 1000 },
    async callTool() {
      calls++;
      return { failed: false, text: "" };
    },
  };
  await assert.rejects(
    qi.prepareProbe(client, {
      receiptPath,
      binding,
      diagnosticPath,
      mapPath: (file) => file,
    }),
    { code: "INSTANCE_UNAVAILABLE" },
  );
  assert.equal(calls, 0);
  assert.deepEqual(qi.readJson(receiptPath), prior);
});

test("bound instance probe accepts a matching optional wire marker", async (t) => {
  const fixture = await boundProbeFixture(t, {
    wireText: (identity) => probeMarker(identity),
  });
  const identity = await fixture.probe();
  assert.equal(record(identity)["version"], "fixture");
  assert.equal(
    readDiagnostic(fixture.diagnosticPath)["wireMarkerPresent"],
    true,
  );
});

test("bound instance probe rejects a wire marker that contradicts its receipt", async (t) => {
  const fixture = await boundProbeFixture(t, {
    wireText: (identity) =>
      probeMarker({ ...identity, pid: Number(identity["pid"]) + 1 }),
  });
  await assert.rejects(fixture.probe(), {
    code: "INSTANCE_UNAVAILABLE",
    message: "Wire identity conflicts with the bound receipt observation",
  });
  const diagnostic = readDiagnostic(fixture.diagnosticPath);
  assert.equal(diagnostic["observationSource"], null);
  assert.equal(diagnostic["wireIdentityConflict"], true);
});
