import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const load = createRequire(__filename);
const { BrokerMcpClient } = load("../src/dist/fusion-transport/mcp") as {
  BrokerMcpClient: typeof import("../packages/node-adapters/src/fusion-transport/mcp").BrokerMcpClient;
};
type BrokerWireClient = InstanceType<
  typeof import("../packages/node-adapters/src/fusion-transport/mcp").BrokerMcpClient
>;
type BrokerHost = {
  serve(
    cfg: Record<string, unknown>,
    options: Omit<
      import("../src/queue-broker-ports").Options,
      "createBackend"
    > & { createBackend(): BrokerWireClient },
  ): Promise<{ close(): Promise<void> }>;
};
const { request } = load("../src/queue-connection") as {
  request<T>(dir: string, message: Record<string, unknown>): Promise<T>;
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
// These cases pin raw MCP response retention and historical receipt decoding
// below backend selection. The public factory's retired-backend refusal is
// exercised separately by server-metadata.test.ts.
// New response-retention failures use an explicit checker fixture. Historical
// native results exercise the production decoder and held IPC reader, with no SDK.
const admissionModule = load("../src/queue-admission") as {
  createProductionQueueAdmission(...args: unknown[]): {
    admission: {
      check(payload: unknown): Promise<{
        kind: string;
        report?: { status: string };
        fence(outgoing: unknown): void;
      }>;
    };
    checkPrepared(prepared: unknown): Promise<unknown>;
    fencePrepared(prepared: unknown, buildHash: string): void;
    checkerFingerprint(): unknown;
  };
};

function matchingRpcFiles(
  names: readonly string[],
  read: (name: string) => unknown,
  expected: {
    jobId: string;
    rpcId: string;
    sourceHash: string;
    wireId: string;
  },
): string[] {
  return names.filter((name) => {
    if (!/^rpc-.*\.json$/.test(name)) return false;
    const rpc = object(read(name));
    const binding = object(rpc["binding"]);
    return (
      name === `rpc-${expected.rpcId}.json` &&
      binding["jobId"] === expected.jobId &&
      binding["rpcId"] === expected.rpcId &&
      binding["sourceHash"] === expected.sourceHash &&
      object(rpc["wireRequest"])["id"] === expected.wireId
    );
  });
}

test("RPC artifact selection binds the product despite terminal siblings and file order", () => {
  const expected = {
    jobId: "00000000-0000-4000-8000-000000000000",
    rpcId: "20000000-0000-4000-8000-000000000000",
    sourceHash: "a".repeat(64),
    wireId: "fmcad:20000000-0000-4000-8000-000000000000",
  };
  const preflightName = "rpc-00000000-0000-4000-8000-000000000001.json";
  const siblingName = "rpc-10000000-0000-4000-8000-000000000000.json";
  const productName = `rpc-${expected.rpcId}.json`;
  const resultName = "rpc-result.json";
  const productBinding = {
    jobId: expected.jobId,
    rpcId: expected.rpcId,
    sourceHash: expected.sourceHash,
  };
  const files = new Map<string, unknown>([
    [
      preflightName,
      {
        terminal: true,
        binding: {
          jobId: expected.jobId,
          rpcId: "00000000-0000-4000-8000-000000000001",
        },
        wireRequest: { id: "fmcad:00000000-0000-4000-8000-000000000001" },
      },
    ],
    [
      siblingName,
      {
        terminal: true,
        binding: {
          jobId: expected.jobId,
          rpcId: "10000000-0000-4000-8000-000000000000",
          sourceHash: "b".repeat(64),
        },
        wireRequest: { id: "fmcad:10000000-0000-4000-8000-000000000000" },
      },
    ],
    [
      productName,
      {
        terminal: false,
        binding: productBinding,
        wireRequest: { id: expected.wireId },
      },
    ],
    [
      resultName,
      {
        terminal: true,
        binding: productBinding,
        wireRequest: { id: expected.wireId },
      },
    ],
  ]);
  const read = (name: string) => files.get(name);
  const adversarialOrder = [
    preflightName,
    resultName,
    siblingName,
    productName,
  ];

  assert.equal(
    adversarialOrder.find((name) => /^rpc-.*\.json$/.test(name)),
    preflightName,
    "the old first-match lookup chooses a terminal preflight RPC",
  );
  for (const order of [
    adversarialOrder,
    [...adversarialOrder].reverse(),
    [siblingName, productName, preflightName, resultName],
  ]) {
    assert.deepEqual(matchingRpcFiles(order, read, expected), [productName]);
  }
  assert.deepEqual(
    matchingRpcFiles([preflightName, siblingName, resultName], read, expected),
    [],
    "terminal sibling RPCs and rpc-result.json are not the product RPC",
  );
});

async function readArchivedNativeResult(
  t: import("node:test").TestContext,
  mode: string,
) {
  const qi = load("../src/queue-instance") as ReturnType<
    typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
  >;
  const { QueueState } = load(
    "../src/queue-state",
  ) as typeof import("../src/queue-state");
  const { decodeBoundPublicPythonResponse } = load(
    "../src/dist/composition/queue-public-python-result",
  ) as typeof import("../src/composition/queue-public-python-result");
  const fixture = path.resolve(
    __dirname,
    "../../tests/fixtures/unknown-public-python",
  );
  const capturedBytes = fs.readFileSync(
    path.join(fixture, "received-response.json"),
  );
  const receiptBytes = fs.readFileSync(
    path.join(fixture, "remote-receipt.json"),
  );
  const sha = (value: string | Uint8Array) =>
    createHash("sha256").update(value).digest("hex");
  assert.equal(
    sha(capturedBytes),
    "f76b023ab7843ce596f730d0b5f4a8df7216d05da728c21952dd5798ad707cda",
  );
  assert.equal(
    sha(receiptBytes),
    "0708bbfb4bb0303205c0b807e4c792b6219dceb8209b9a175d4681982d7f22c2",
  );
  const captured = JSON.parse(capturedBytes.toString());
  const receipt = JSON.parse(receiptBytes.toString());
  assert.equal(
    sha(captured.response.raw),
    "7682ddd6cbd1539d452a51e1dc0443756959adca780f0b74d2f7f9a3098a73d7",
  );
  const source = 'print("FUSION_ADDIN_STDIO_OK")';
  assert.equal(captured.binding.sourceHash, sha(source));
  for (const [key, value] of Object.entries(captured.binding))
    assert.deepEqual(receipt[key], value, `archived binding ${key}`);
  assert.equal(captured.wireId, `fmcad:${captured.binding.rpcId}`);
  const instance = structuredClone(receipt.instance);
  const originalRequest = {
    jsonrpc: "2.0",
    id: "archived-caller",
    method: "tools/call",
    params: {
      name: "execute_python",
      arguments: { code: source, persistent: false },
    },
  };
  const reply = JSON.parse(captured.response.raw);
  const publicValue = {
    success: true,
    stdout: "FUSION_ADDIN_STDIO_OK\n",
    stderr: "",
  };
  if (mode === "native-legacy-python")
    reply.result.content[0].text = JSON.stringify({
      success: true,
      message: JSON.stringify(publicValue) + "\n",
    });
  if (mode === "native-wire-conflict")
    reply.result.content[0].text = JSON.stringify({
      success: true,
      message: JSON.stringify({ ...publicValue, stdout: "conflicting stdout" }),
    });
  if (mode === "native-structured-conflict")
    reply.result.structuredContent = { stdout: "conflicting stdout" };
  const response = {
    status: captured.response.status,
    raw:
      mode === "native-authentic-empty-fixture-offline-adapter"
        ? captured.response.raw
        : JSON.stringify(reply),
  };
  if (mode === "native-missing-result") delete receipt.publicPythonResult;
  if (mode === "native-partial-result")
    receipt.publicPythonResult.value = { success: true };
  if (mode === "native-extra-result")
    receipt.publicPythonResult.value.extra = true;
  if (mode === "native-wrong-schema")
    receipt.publicPythonResult.schema = "foreign";
  if (mode === "native-wrong-binding")
    receipt.publicPythonResultSchema = "foreign";
  if (mode === "native-wrong-instance") receipt.instance.birth = "foreign";
  if (mode === "native-nonterminal-result") receipt.terminal = false;
  if (mode === "native-extra-receipt") receipt.unexpected = true;
  const record = {
    backend: "mcp", // Archived provenance, never a selected physical backend.
    binding: captured.binding,
    instance,
    request: originalRequest,
    wireRequest: { jsonrpc: "2.0", id: captured.wireId, method: "tools/call" },
    method: "tools/call",
    terminal: receipt.terminal,
    remoteReceipt: receipt,
    response,
  };
  const beforeDecode = JSON.stringify({
    record,
    receipt,
    originalRequest,
    response,
    reply,
  });
  const decode = () =>
    decodeBoundPublicPythonResponse(
      record,
      receipt,
      originalRequest,
      response,
      reply,
    );
  const succeeded = [
    "native-legacy-python",
    "native-wire-empty",
    "native-authentic-empty-fixture-offline-adapter",
  ].includes(mode);
  let callerResponse: { status: number; raw: string } | undefined;
  if (succeeded) {
    callerResponse = decode();
    const caller = JSON.parse(callerResponse.raw);
    assert.equal(caller.id, originalRequest.id);
    assert.equal(caller.result.isError, false);
    assert.deepEqual(JSON.parse(caller.result.content[0].text), publicValue);
    assert.throws(
      () =>
        decodeBoundPublicPythonResponse(
          record,
          receipt,
          {
            ...originalRequest,
            params: {
              ...originalRequest.params,
              arguments: {
                ...originalRequest.params.arguments,
                code: source + "\n# foreign",
              },
            },
          },
          response,
          reply,
        ),
      { code: "RECEIPT_MISMATCH" },
      "A caller result must stay bound to the exact archived Python source",
    );
  } else {
    assert.throws(decode, (error: unknown) =>
      ["RECEIPT_MISMATCH", "UNKNOWN_RPC"].includes(
        String(object(error)["code"]),
      ),
    );
  }
  assert.equal(
    JSON.stringify({ record, receipt, originalRequest, response, reply }),
    beforeDecode,
  );

  // The held broker serves old evidence only: even startup probes are forbidden.
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "archived-native-result-"),
  );
  const dir = path.join(root, "queue");
  fs.mkdirSync(dir);
  const cfg = { backend: "addin", timeoutMs: 1000 };
  const auth = {
    clientId: "archive-owner",
    clientToken: "private-archive-owner",
  };
  const state = new QueueState(dir);
  const blocker = state.submit({
    kind: "rpc",
    requestId: randomUUID(),
    clientId: auth.clientId,
    timeoutMs: 1000,
    payload: { jsonrpc: "2.0", id: "historical-unknown", method: "ping" },
  });
  state.next();
  state.markDispatch(String(blocker["id"]), { rpcCount: 1, completedCount: 0 });
  state.block(String(blocker["id"]), "Archived UNKNOWN; never replay");
  const archived = state.submit({
    kind: "rpc",
    requestId: randomUUID(),
    clientId: auth.clientId,
    timeoutMs: 1000,
    payload: originalRequest,
  });
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
  );
  const persisted = snapshot.jobs[String(archived["id"])];
  delete snapshot.jobs[String(archived["id"])];
  const jobId = captured.binding.jobId;
  snapshot.jobs[jobId] = {
    ...persisted,
    id: jobId,
    state: succeeded ? "succeeded" : "needs_reconciliation",
    dispatch: { rpcCount: 1, completedCount: succeeded ? 1 : 0 },
  };
  if (!succeeded) {
    delete snapshot.jobs[String(blocker["id"])];
    snapshot.active = jobId;
    snapshot.blocked.id = jobId;
  }
  qi.durable(path.join(dir, "queue-state.json"), snapshot);
  const directory = path.join(dir, "jobs", jobId);
  fs.mkdirSync(directory, { recursive: true });
  const artifacts = {
    [`rpc-${captured.binding.rpcId}.json`]: record,
    [`remote-${captured.binding.rpcId}.json`]: receipt,
    [`received-response-${captured.binding.rpcId}.json`]: {
      ...captured,
      response,
    },
    "rpc-result.json": callerResponse ?? response,
  };
  for (const [name, value] of Object.entries(artifacts))
    qi.durable(path.join(directory, name), value);
  const immutable = Object.keys(artifacts).map(
    (name) =>
      [name, fs.readFileSync(path.join(directory, name), "utf8")] as const,
  );
  qi.durable(path.join(dir, "instance.json"), {
    configHash: qi.brokerConfigHash(cfg),
    buildHash: qi.buildHash(),
    instance,
  });
  let sends = 0;
  const never = (): never => {
    sends++;
    assert.fail(
      "Historical result retrieval must never dispatch or initialize SDK",
    );
  };
  const { serve } = load(
    "../src/queue-broker",
  ) as typeof import("../src/queue-broker");
  await assert.rejects(
    serve(
      { backend: "mcp", timeoutMs: 1000 },
      {
        dir,
        confirmOwnership: true,
        createBackend: never,
      },
    ),
    { code: "UNSUPPORTED_BACKEND" },
  );
  assert.equal(
    sends,
    0,
    "Retired backend refusal precedes client construction",
  );
  const broker = await serve(cfg, {
    dir,
    confirmOwnership: true,
    createBackend: () => ({
      server: cfg,
      _post: never,
      _openSession: never,
      callTool: never,
      prepareCallTool: never,
      listTools: never,
      executeUiGuardedScript: never,
      _parse: JSON.parse,
    }),
  });
  t.after(async () => {
    await assert.rejects(broker.close(), { code: "RECONCILIATION_REQUIRED" });
    assert.equal(sends, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });
  await request(dir, { action: "register", ...auth });
  const stateBefore = fs.readFileSync(
    path.join(dir, "queue-state.json"),
    "utf8",
  );
  const result = await request<{
    job: { state: string; operationResult: { executionOutcome: string } };
    rpc: unknown;
  }>(dir, { action: "result", auth, jobId });
  assert.equal(
    result.job.state,
    succeeded ? "succeeded" : "needs_reconciliation",
  );
  if (!succeeded)
    assert.equal(result.job.operationResult.executionOutcome, "unknown");
  assert.deepEqual(result.rpc, callerResponse ?? response);
  const foreign = { clientId: "foreign-owner", clientToken: "private-foreign" };
  await request(dir, { action: "register", ...foreign });
  await assert.rejects(
    request(dir, { action: "result", auth: foreign, jobId }),
    { code: "NOT_OWNER" },
  );
  await assert.rejects(
    request(dir, { action: "reconcile", auth, jobId }),
    { code: succeeded ? "NOT_BLOCKED" : "RECEIPT_MISMATCH" },
    "Reading an archive does not grant reconciliation or replay authority",
  );
  assert.equal(sends, 0);
  assert.equal(
    fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
    stateBefore,
  );
  for (const [name, bytes] of immutable)
    assert.equal(fs.readFileSync(path.join(directory, name), "utf8"), bytes);
  return {
    archived: true,
    readerId: randomUUID(),
    requestId: archived["requestId"],
    jobId,
    rpcId: captured.binding.rpcId,
    sourceHash: captured.binding.sourceHash,
    rawSha256: sha(response.raw),
  };
}

for (const responseMode of [
  "missing-receipt",
  "foreign-jsonrpc",
  "malformed-jsonrpc",
  "http-error",
  "native-legacy-python",
  "native-wire-empty",
  "native-authentic-empty-fixture-offline-adapter",
  "native-missing-result",
  "native-partial-result",
  "native-extra-result",
  "native-wrong-schema",
  "native-wrong-binding",
  "native-wrong-instance",
  "native-nonterminal-result",
  "native-wire-conflict",
  "native-structured-conflict",
  "native-extra-receipt",
]) {
  const nativePython = responseMode.startsWith("native-");
  const scenario = nativePython
    ? "archived native result verifies binding and preserves owned evidence"
    : "owned RPC retains returned raw before settlement failure";
  test(`${scenario}: ${responseMode}`, async (t) => {
    if (!process.env["FMCAD_RETAINED_RPC_CHILD"]) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        FMCAD_RETAINED_RPC_CHILD: "1",
      };
      delete env["NODE_TEST_CONTEXT"];
      const runs =
        responseMode === "native-authentic-empty-fixture-offline-adapter"
          ? 2
          : 1;
      const outputs = await Promise.all(
        Array.from(
          { length: runs },
          () =>
            new Promise<string>((resolve, reject) => {
              const child = spawn(
                process.execPath,
                [
                  "--test",
                  "--test-force-exit",
                  "--test-name-pattern",
                  responseMode,
                  __filename,
                ],
                { env, timeout: nativePython ? 90000 : 20000 },
              );
              let stdout = "";
              let stderr = "";
              child.stdout.setEncoding("utf8");
              child.stderr.setEncoding("utf8");
              child.stdout.on("data", (chunk: string) => (stdout += chunk));
              child.stderr.on("data", (chunk: string) => (stderr += chunk));
              child.once("error", reject);
              child.once("close", (code, signal) => {
                if (code !== 0) {
                  reject(
                    new Error(
                      `Fixture child exited ${code ?? signal}: ${stdout}${stderr}`,
                    ),
                  );
                } else if (!/tests 1\b/.test(stdout)) {
                  reject(new Error(stdout + stderr));
                } else {
                  resolve(stdout);
                }
              });
            }),
        ),
      );
      if (runs === 2) {
        const results = outputs.map((output) => {
          const line = output
            .split("\n")
            .map((value) => value.replace(/^#\s?/, ""))
            .find((value) => value.startsWith("PUBLIC_PYTHON_FIXTURE_RESULT "));
          assert.ok(line, output);
          return JSON.parse(line.slice("PUBLIC_PYTHON_FIXTURE_RESULT ".length));
        });
        assert.notEqual(results[0].readerId, results[1].readerId);
        assert.equal(results[0].jobId, results[1].jobId);
        assert.equal(results[0].rpcId, results[1].rpcId);
        assert.equal(results[0].sourceHash, results[1].sourceHash);
        assert.equal(results[0].rawSha256, results[1].rawSha256);
        console.log("PUBLIC_PYTHON_FIXTURE_RUNS " + JSON.stringify(results));
      }
      return;
    }
    if (nativePython) {
      const archived = await readArchivedNativeResult(t, responseMode);
      console.log("PUBLIC_PYTHON_FIXTURE_RESULT " + JSON.stringify(archived));
      return;
    }
    const originalAdmission = admissionModule.createProductionQueueAdmission;
    admissionModule.createProductionQueueAdmission = () => ({
      admission: {
        async check() {
          return { kind: "python", fence() {} };
        },
      },
      async checkPrepared() {
        return {};
      },
      fencePrepared() {},
      checkerFingerprint() {
        return "explicit synthetic checker: response-retention test only";
      },
    });
    t.after(() => {
      admissionModule.createProductionQueueAdmission = originalAdmission;
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-rpc-retained-"));
    const dir = path.join(root, "queue");
    fs.mkdirSync(dir);
    const instance = {
      pid: 991,
      birth: "synthetic:991",
      version: "fixture",
      activeCommand: "SelectCommand",
      documents: [],
    };
    const cfg = {
      backend: "addin",
      routing: "queue",
      url: "http://synthetic.invalid",
      timeoutMs: 30000,
    };
    const physical = new BrokerMcpClient(cfg, {
      version: "synthetic",
      requestTimeout: () => 30000,
      bridgeSource: () => {
        throw new Error("No add-in bridge");
      },
    });
    let productCalls = 0;
    let productWireId: string | undefined;
    let originalRaw = "";
    const sourceCode =
      "def run(context: str) -> None:\n    print('synthetic owned write result')\n";
    const sourceHash = createHash("sha256").update(sourceCode).digest("hex");
    physical._post = async (payload) => {
      if (payload["method"] === "initialize")
        return {
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload["id"],
            result: { protocolVersion: "2025-03-26" },
          }),
        };
      if (payload["method"] === "notifications/initialized")
        return { status: 202, raw: "" };
      const args = object(object(payload["params"])["arguments"]);
      const wireCode =
        typeof args["code"] === "string"
          ? args["code"]
          : object(args["object"])["script"];
      assert.ok(typeof wireCode === "string");
      const { prepareWireArtifact } = load(
        "../src/dist/python/source-units",
      ) as typeof import("../packages/node-adapters/src/python/source-units");
      // Inspect the actual envelope's bounded AST inventory, not a particular
      // plain/compressed representation. This does not execute Python or adsk.
      const inventory = prepareWireArtifact(
        path.resolve(__dirname, "../runtime/python"),
        wireCode,
      );
      const code = inventory.units.map((unit) => unit.source).join("\n");
      if (code.includes("FMCAD_QUEUE_INSTANCE")) {
        const filename = /_qr_path = ("(?:\\.|[^"\\])*")/.exec(code);
        const binding =
          /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/.exec(
            code,
          );
        if (filename && binding) {
          const target = JSON.parse(filename[1]!);
          assert.ok(target.startsWith(root + path.sep));
          fs.writeFileSync(
            target,
            JSON.stringify({
              ...JSON.parse(JSON.parse(binding[1]!)),
              terminal: true,
              outcome: "succeeded",
              instance,
              probeObservation: {
                schema: "fmcad-instance-probe-v1",
                identity: instance,
              },
            }),
          );
        }
        return {
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload["id"],
            result: {
              content: [
                {
                  type: "text",
                  text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance),
                },
              ],
            },
          }),
        };
      }
      productCalls++;
      const wireId = payload["id"];
      assert.ok(typeof wireId === "string");
      productWireId = wireId;
      // A physical-port response, not a Fusion execution or model assertion. No
      // remote receipt is emitted, exactly the settlement boundary under test.
      originalRaw =
        responseMode === "malformed-jsonrpc"
          ? "original malformed JSON"
          : responseMode === "http-error"
            ? "original HTTP failure body"
            : JSON.stringify({
                jsonrpc: "2.0",
                id:
                  responseMode === "foreign-jsonrpc"
                    ? "foreign-wire-id"
                    : payload["id"],
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        success: false,
                        message: "synthetic original native error",
                      }),
                    },
                  ],
                },
              });
      return {
        status: responseMode === "http-error" ? 503 : 200,
        raw: originalRaw,
      };
    };
    // The broker captures the admission constructor at module initialization.
    // Load it only after selecting the explicit fixture or real checker above.
    const { serve } = load("../src/queue-broker") as BrokerHost;
    const broker = await serve(cfg, {
      dir,
      confirmOwnership: true,
      pollMs: 5,
      createBackend: () => physical,
      nativePath: (value: string) => value,
    });
    t.after(async () => {
      await assert.rejects(broker.close(), {
        code: "RECONCILIATION_REQUIRED",
      });
      fs.rmSync(root, { recursive: true, force: true });
    });
    const auth = {
      clientId: "owned-synthetic-client",
      clientToken: "synthetic-private-test-token",
    };
    await request(dir, { action: "register", ...auth });
    const job = await request<{ id: string }>(dir, {
      action: "submit",
      auth,
      request: {
        kind: "rpc",
        requestId: randomUUID(),
        cwd: root,
        timeoutMs: 30000,
        payload: {
          jsonrpc: "2.0",
          id: "synthetic-caller",
          method: "tools/call",
          params: {
            name: "fusion_mcp_execute",
            arguments: {
              featureType: "script",
              object: {
                script: sourceCode,
                readOnly: false,
              },
            },
          },
        },
      },
    });
    const deadline = Date.now() + 30000;
    let result: { job: { state: string } };
    do {
      result = await request(dir, { action: "result", auth, jobId: job.id });
      if (
        ["needs_reconciliation", "succeeded", "failed"].includes(
          result.job.state,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.equal(result.job.state, "needs_reconciliation");
    assert.equal(productCalls, 1, "No SDK request or response may be replayed");
    const directory = path.join(dir, "jobs", job.id);
    assert.ok(
      typeof productWireId === "string" && productWireId.startsWith("fmcad:"),
      "the product RPC must have a unique broker wire ID",
    );
    const wireId = productWireId;
    const rpcId = wireId.slice("fmcad:".length);
    const expectedBinding = { jobId: job.id, rpcId, sourceHash, wireId };
    const rpcNames = matchingRpcFiles(
      fs.readdirSync(directory),
      (name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")),
      expectedBinding,
    );
    assert.equal(rpcNames.length, 1, "select exactly the original product RPC");
    const rpcName = rpcNames[0]!;
    const rpc = JSON.parse(
      fs.readFileSync(path.join(directory, rpcName), "utf8"),
    );
    assert.equal(rpc.binding.jobId, job.id);
    assert.equal(rpc.binding.rpcId, rpcId);
    assert.equal(rpc.binding.sourceHash, sourceHash);
    assert.equal(rpc.wireRequest.id, wireId);
    assert.equal(
      rpc.terminal,
      false,
      "Retained HTTP response is not terminal SDK authority",
    );
    assert.equal(fs.existsSync(rpc.receipt), false);
    const receivedPath = path.join(
      directory,
      `received-response-${rpc.binding.rpcId}.json`,
    );
    assert.ok(
      fs.existsSync(receivedPath),
      "Original returned response must survive failed receipt settlement",
    );
    const received = JSON.parse(fs.readFileSync(receivedPath, "utf8"));
    assert.deepEqual(received.binding, rpc.binding);
    assert.equal(received.wireId, wireId);
    assert.equal(received.version, 1);
    assert.equal(received.kind, "owned-rpc-received-response-v1");
    assert.equal(
      received.response.status,
      responseMode === "http-error" ? 503 : 200,
    );
    assert.equal(received.response.raw, originalRaw);
  });
}
