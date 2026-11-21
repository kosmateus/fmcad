import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const load = createRequire(__filename);
const { createBrokerTransport } = load(
  "../src/dist/fusion-transport/broker",
) as typeof import("../packages/node-adapters/src/fusion-transport/broker");
type BrokerHost = {
  serve(
    cfg: Record<string, unknown>,
    options: Omit<
      import("../src/queue-broker-ports").Options,
      "createBackend"
    > & { createBackend(): ReturnType<typeof createBrokerTransport> },
  ): Promise<{ close(): Promise<void> }>;
};
const { request } = load("../src/queue-connection") as {
  request<T>(dir: string, message: Record<string, unknown>): Promise<T>;
};
const { createQueuePost, createForwarder } = load(
  "../src/dist/composition/library-mcp-compat",
) as typeof import("../src/composition/library-mcp-compat");
const debugTraceRuntime = load(
  "../../packages/node-adapters/dist/telemetry/diagnostic-log",
) as {
  createDebugTraceContext?: (
    requestId: string,
    clientId: string,
    source: "cli" | "mcp",
    enabled?: boolean,
  ) => { traceId: string } | undefined;
  flushDebugTrace?: () => Promise<void>;
  readDebugTrace?: (
    traceId: string,
    options?: { directory?: string },
  ) => Array<Record<string, unknown>>;
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
// Retention failures use an explicit checker fixture. The native compatibility
// regression below additionally certifies the real final wire with production.
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
  test(`owned RPC retains returned raw before settlement failure: ${responseMode}`, async (t) => {
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
        assert.notEqual(results[0].requestId, results[1].requestId);
        assert.notEqual(results[0].jobId, results[1].jobId);
        assert.notEqual(results[0].rpcId, results[1].rpcId);
        assert.notEqual(results[0].traceId, results[1].traceId);
        console.log("PUBLIC_PYTHON_FIXTURE_RUNS " + JSON.stringify(results));
      }
      return;
    }
    const originalAdmission = admissionModule.createProductionQueueAdmission;
    let realChecks = 0;
    if (nativePython) {
      admissionModule.createProductionQueueAdmission = (...args) => {
        const production = originalAdmission(...args);
        return {
          ...production,
          admission: {
            ...production.admission,
            async check(payload, ...rest: unknown[]) {
              const certificate = await Reflect.apply(
                production.admission.check,
                production.admission,
                [payload, ...rest],
              );
              if (certificate.kind === "python") {
                assert.equal(certificate.report?.status, "passed");
                realChecks++;
              }
              return certificate;
            },
          },
        };
      };
    } else
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
      backend: "mcp",
      routing: "queue",
      url: "http://synthetic.invalid",
      timeoutMs: 30000,
    };
    const physical = createBrokerTransport(cfg, {
      version: "synthetic",
      requestTimeout: () => 30000,
      bridgeSource: () => {
        throw new Error("No add-in bridge");
      },
    });
    let productCalls = 0;
    let productWireId: string | undefined;
    let originalRaw = "";
    const sourceCode = nativePython
      ? 'print("FUSION_ADDIN_STDIO_OK")'
      : "def run(context: str) -> None:\n    print('synthetic owned write result')\n";
    const sourceHash = createHash("sha256").update(sourceCode).digest("hex");
    const authenticFixture =
      responseMode === "native-authentic-empty-fixture-offline-adapter";
    const fixtureDirectory = path.resolve(
      __dirname,
      "../../tests/fixtures/unknown-public-python",
    );
    const capturedResponse = authenticFixture
      ? JSON.parse(
          fs.readFileSync(
            path.join(fixtureDirectory, "received-response.json"),
            "utf8",
          ),
        )
      : undefined;
    const capturedReceipt = authenticFixture
      ? JSON.parse(
          fs.readFileSync(
            path.join(fixtureDirectory, "remote-receipt.json"),
            "utf8",
          ),
        )
      : undefined;
    if (authenticFixture) {
      assert.equal(
        createHash("sha256")
          .update(
            fs.readFileSync(
              path.join(fixtureDirectory, "received-response.json"),
            ),
          )
          .digest("hex"),
        "f76b023ab7843ce596f730d0b5f4a8df7216d05da728c21952dd5798ad707cda",
      );
      assert.equal(
        createHash("sha256")
          .update(
            fs.readFileSync(path.join(fixtureDirectory, "remote-receipt.json")),
          )
          .digest("hex"),
        "0708bbfb4bb0303205c0b807e4c792b6219dceb8209b9a175d4681982d7f22c2",
      );
      assert.equal(capturedResponse.binding.jobId, capturedReceipt.jobId);
      assert.equal(capturedResponse.binding.rpcId, capturedReceipt.rpcId);
      assert.equal(
        capturedResponse.binding.requestHash,
        capturedReceipt.requestHash,
      );
      assert.equal(
        capturedResponse.binding.buildHash,
        capturedReceipt.buildHash,
      );
      assert.equal(capturedResponse.binding.sourceHash, sourceHash);
      assert.equal(
        capturedResponse.binding.sourceHash,
        capturedReceipt.sourceHash,
      );
      assert.equal(
        capturedResponse.wireId,
        `fmcad:${capturedResponse.binding.rpcId}`,
      );
      assert.equal(capturedResponse.response.status, 200);
      assert.equal(
        createHash("sha256")
          .update(capturedResponse.response.raw)
          .digest("hex"),
        "7682ddd6cbd1539d452a51e1dc0443756959adca780f0b74d2f7f9a3098a73d7",
      );
      const fixtureEnvelope = JSON.parse(capturedResponse.response.raw);
      const fixtureOuter = JSON.parse(fixtureEnvelope.result.content[0].text);
      assert.equal(fixtureOuter.success, true);
      assert.equal(fixtureOuter.message, "");
      assert.equal(capturedReceipt.terminal, true);
      assert.equal(capturedReceipt.outcome, "succeeded");
      assert.equal(
        capturedReceipt.publicPythonResult.schema,
        "fmcad-public-python-result-v1",
      );
      assert.deepEqual(capturedReceipt.publicPythonResult.value, {
        success: true,
        stdout: "FUSION_ADDIN_STDIO_OK\n",
        stderr: "",
      });
    }
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
      if (nativePython) {
        assert.equal(
          object(payload["params"])["name"],
          "fusion_mcp_execute",
          "Native Fusion does not advertise the public execute_python tool",
        );
        assert.equal(args["featureType"], "script");
        assert.equal(
          object(args["object"])["readOnly"],
          false,
          "Arbitrary public Python must not claim native read-only authority",
        );
        assert.match(code, /def run\(_context: str\)/);
        const publicEntry = inventory.units.find((unit) =>
          unit.source.startsWith("import contextlib as _qp_contextlib\n"),
        );
        assert.ok(
          publicEntry,
          "Keep the public compatibility entrypoint in the checked source inventory",
        );
        const evaluated = spawnSync(
          "python3",
          [
            "-I",
            "-S",
            "-c",
            "import sys; ns = {}; exec(sys.stdin.read(), ns); ns['run']('')",
          ],
          { input: publicEntry.source, encoding: "utf8", timeout: 10000 },
        );
        assert.equal(evaluated.status, 0, evaluated.stderr);
        assert.deepEqual(JSON.parse(evaluated.stdout), {
          success: true,
          stdout: "FUSION_ADDIN_STDIO_OK\n",
          stderr: "",
        });
        const filename = /_qr_path = ("(?:\\.|[^"\\])*")/.exec(code);
        const binding =
          /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/.exec(
            code,
          );
        assert.ok(
          filename && binding,
          "The transformed native script still requires its exact SDK receipt",
        );
        const receipt: Record<string, unknown> = {
          ...JSON.parse(JSON.parse(binding[1]!)),
          terminal: true,
          outcome: "succeeded",
          instance,
          publicPythonResult: authenticFixture
            ? capturedReceipt.publicPythonResult
            : {
                schema: "fmcad-public-python-result-v1",
                value: {
                  success: true,
                  stdout: "FUSION_ADDIN_STDIO_OK\n",
                  stderr: "",
                },
              },
        };
        if (responseMode === "native-missing-result")
          delete receipt["publicPythonResult"];
        if (responseMode === "native-partial-result")
          receipt["publicPythonResult"] = {
            schema: "fmcad-public-python-result-v1",
            value: { success: true },
          };
        if (responseMode === "native-extra-result")
          receipt["publicPythonResult"] = {
            schema: "fmcad-public-python-result-v1",
            value: {
              success: true,
              stdout: "FUSION_ADDIN_STDIO_OK\n",
              stderr: "",
              extra: true,
            },
          };
        if (responseMode === "native-wrong-schema")
          receipt["publicPythonResult"] = {
            schema: "foreign",
            value: { success: true, stdout: "x", stderr: "" },
          };
        if (responseMode === "native-wrong-binding")
          receipt["publicPythonResultSchema"] = "foreign";
        if (responseMode === "native-wrong-instance")
          receipt["instance"] = { ...instance, birth: "foreign" };
        if (responseMode === "native-nonterminal-result")
          receipt["terminal"] = false;
        if (responseMode === "native-extra-receipt")
          receipt["unexpected"] = true;
        fs.writeFileSync(JSON.parse(filename[1]!), JSON.stringify(receipt));
        if (authenticFixture) {
          const wireId = String(payload["id"]);
          const oldId = `"id":${JSON.stringify(capturedResponse.wireId)}`;
          const newId = `"id":${JSON.stringify(wireId)}`;
          assert.equal(
            capturedResponse.response.raw.split(oldId).length - 1,
            1,
          );
          productWireId = wireId;
          originalRaw = capturedResponse.response.raw.replace(oldId, newId);
          assert.equal(
            originalRaw.replace(newId, oldId),
            capturedResponse.response.raw,
          );
          return { status: capturedResponse.response.status, raw: originalRaw };
        }
        originalRaw = JSON.stringify({
          jsonrpc: "2.0",
          id: payload["id"],
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  message:
                    responseMode === "native-legacy-python"
                      ? JSON.stringify({
                          success: true,
                          stdout: "FUSION_ADDIN_STDIO_OK\n",
                          stderr: "",
                        }) + "\n"
                      : responseMode === "native-wire-conflict"
                        ? JSON.stringify({
                            success: true,
                            stdout: "conflicting stdout",
                            stderr: "",
                          })
                        : "",
                  success: true,
                }),
              },
            ],
            ...(responseMode === "native-structured-conflict"
              ? { structuredContent: { stdout: "conflicting stdout" } }
              : {}),
          },
        });
        return { status: 200, raw: originalRaw };
      }
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
      if (
        [
          "native-legacy-python",
          "native-wire-empty",
          "native-authentic-empty-fixture-offline-adapter",
        ].includes(responseMode)
      )
        await broker.close();
      else
        await assert.rejects(broker.close(), {
          code: "RECONCILIATION_REQUIRED",
        });
      fs.rmSync(root, { recursive: true, force: true });
    });
    const auth = {
      clientId: "owned-synthetic-client",
      clientToken: "synthetic-private-test-token",
    };
    if (authenticFixture) {
      const oldTmpDir = process.env["TMPDIR"];
      const oldTraceSetting = process.env["FMCAD_DEBUG_TRACE"];
      process.env["TMPDIR"] = root;
      process.env["FMCAD_DEBUG_TRACE"] = "1";
      t.after(() => {
        if (oldTmpDir === undefined) delete process.env["TMPDIR"];
        else process.env["TMPDIR"] = oldTmpDir;
        if (oldTraceSetting === undefined)
          delete process.env["FMCAD_DEBUG_TRACE"];
        else process.env["FMCAD_DEBUG_TRACE"] = oldTraceSetting;
      });
      const requestId = randomUUID();
      const expectedMode =
        process.env["FMCAD_EXPECT_PUBLIC_PYTHON_RESULT"] ?? "fixed";
      const expectTrace =
        expectedMode !== "baseline" &&
        process.env["FMCAD_EXPECT_DEBUG_TRACE"] !== "0";
      if (expectTrace) {
        assert.equal(
          typeof debugTraceRuntime.createDebugTraceContext,
          "function",
        );
        assert.equal(typeof debugTraceRuntime.flushDebugTrace, "function");
        assert.equal(typeof debugTraceRuntime.readDebugTrace, "function");
      }
      const traceContext = expectTrace
        ? debugTraceRuntime.createDebugTraceContext!(
            requestId,
            auth.clientId,
            "mcp",
            true,
          )
        : undefined;
      if (expectTrace) assert.ok(traceContext);
      const queueClient = {
        dir,
        auth,
        async register() {
          await request(dir, { action: "register", ...auth });
        },
        submit(input: Record<string, unknown>) {
          return request<{ id: string }>(dir, {
            action: "submit",
            auth,
            request: input,
          });
        },
        async wait(jobId: string, options: { signal: AbortSignal }) {
          while (!options.signal.aborted) {
            const result = await request<{ job: { state: string } }>(dir, {
              action: "result",
              auth,
              jobId,
            });
            if (
              ["succeeded", "failed", "needs_reconciliation"].includes(
                result.job.state,
              )
            )
              return result;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error("Offline queue wait was aborted");
        },
        call(action: string, args: Record<string, unknown> = {}) {
          return request(dir, { action, auth, ...args });
        },
        async findRequest() {
          return null;
        },
        persistRequestContext() {},
        dispose() {},
      };
      const queuePost = createQueuePost(
        queueClient as unknown as import("../src/composition/library-mcp-queue").McpQueueClient,
        cfg,
        undefined,
        { clientId: auth.clientId, projectDirectory: root },
      );
      const frames: string[] = [];
      const forward = createForwarder(
        queuePost,
        (_message, frame) => {
          if (frame) frames.push(frame);
        },
        () => {},
        cfg,
      );
      const callerId = randomUUID();
      await forward(
        JSON.stringify({
          jsonrpc: "2.0",
          id: callerId,
          method: "tools/call",
          params: {
            name: "execute_python",
            arguments: { code: sourceCode, persistent: false },
            _meta: { fmcad: { requestId } },
          },
        }),
      );
      assert.equal(frames.length, 1);
      const callerResponse = JSON.parse(frames[0]!);
      assert.equal(callerResponse.id, callerId);
      const publicResult = callerResponse.result;
      const queueReceipt = publicResult._meta.fmcad;
      const jobId = queueReceipt.jobId;
      assert.equal(queueReceipt.requestId, requestId);
      assert.equal(queueReceipt.state, "succeeded");
      assert.equal(productCalls, 1);
      assert.ok(realChecks >= 3);
      const publicValue = JSON.parse(publicResult.content[0].text);
      if (expectedMode === "baseline") {
        assert.deepEqual(publicValue, { success: true, message: "" });
      } else {
        assert.deepEqual(publicValue, {
          success: true,
          stdout: "FUSION_ADDIN_STDIO_OK\n",
          stderr: "",
        });
      }
      const final = await request<{
        job: { state: string };
        rpc: { raw: string };
      }>(dir, { action: "result", auth, jobId });
      assert.equal(final.job.state, "succeeded");
      const directory = path.join(dir, "jobs", jobId);
      const rpcFiles = fs
        .readdirSync(directory)
        .filter((name) => /^rpc-.*\.json$/.test(name));
      const product = rpcFiles
        .map((name) =>
          JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")),
        )
        .find((record) => record.binding?.sourceHash === sourceHash);
      assert.ok(product);
      assert.equal(product.binding.jobId, jobId);
      assert.equal(product.binding.sourceHash, sourceHash);
      assert.equal(product.terminal, true);
      assert.equal(product.remoteReceipt.outcome, "succeeded");
      assert.deepEqual(
        product.remoteReceipt.publicPythonResult,
        capturedReceipt.publicPythonResult,
      );
      for (const [key, value] of Object.entries(product.binding))
        assert.deepEqual(
          product.remoteReceipt[key],
          value,
          `receipt binding ${key}`,
        );
      const retained = JSON.parse(
        fs.readFileSync(
          path.join(
            directory,
            `received-response-${product.binding.rpcId}.json`,
          ),
          "utf8",
        ),
      );
      assert.equal(retained.response.raw, originalRaw);
      assert.equal(retained.binding.jobId, jobId);
      assert.equal(retained.binding.rpcId, product.binding.rpcId);
      assert.equal(retained.binding.sourceHash, sourceHash);
      assert.notEqual(retained.binding.jobId, capturedResponse.binding.jobId);
      assert.notEqual(retained.binding.rpcId, capturedResponse.binding.rpcId);
      assert.equal(
        createHash("sha256").update(retained.response.raw).digest("hex"),
        createHash("sha256").update(originalRaw).digest("hex"),
      );
      let traceStages: unknown[] = [];
      if (expectTrace) {
        assert.ok(traceContext);
        await debugTraceRuntime.flushDebugTrace!();
        const diagnosticDirectory = path.join(
          root,
          `fmcad-diagnostics-${process.getuid?.() ?? "user"}`,
        );
        const events = debugTraceRuntime.readDebugTrace!(traceContext.traceId, {
          directory: diagnosticDirectory,
        });
        assert.ok(events.length >= 9);
        assert.ok(
          events.every(
            (event) =>
              event["schema"] === "fmcad-debug-trace-v1" &&
              event["traceId"] === traceContext.traceId,
          ),
        );
        const stages = events.map((event) => event["stage"]);
        let previousStageIndex = -1;
        for (const stage of [
          "request-accepted",
          "preflight",
          "sdk-dispatch",
          "raw-received",
          "parsed",
          "native-receipt",
          "result-published",
          "caller-received",
          "stdout-written",
        ]) {
          const index = stages.indexOf(stage);
          assert.ok(
            index > previousStageIndex,
            `Missing or out-of-order trace stage ${stage}`,
          );
          previousStageIndex = index;
        }
        const rawEvent = events.find(
          (event) =>
            event["stage"] === "raw-received" &&
            event["rpcId"] === product.binding.rpcId,
        );
        assert.ok(rawEvent, "Missing raw response trace for product RPC");
        assert.equal(rawEvent?.["jobId"], jobId);
        assert.equal(rawEvent?.["requestId"], requestId);
        assert.equal(rawEvent?.["rpcId"], product.binding.rpcId);
        assert.equal(rawEvent?.["buildHash"], product.binding.buildHash);
        assert.equal(rawEvent?.["sourceHash"], sourceHash);
        assert.equal(
          rawEvent?.["rawSha256"],
          createHash("sha256").update(originalRaw).digest("hex"),
        );
        assert.equal(rawEvent?.["stdoutObservation"], "not_observed");
        const writtenEvent = events.find(
          (event) => event["stage"] === "stdout-written",
        );
        assert.equal(
          writtenEvent?.["stdoutObservation"],
          expectedMode === "baseline" ? "not_observed" : "observed_nonempty",
        );
        traceStages = stages;
      } else {
        assert.equal(traceContext, undefined);
      }
      process.stdout.write(
        "PUBLIC_PYTHON_FIXTURE_RESULT " +
          JSON.stringify({
            requestId,
            jobId,
            rpcId: product.binding.rpcId,
            traceId: traceContext?.traceId ?? null,
            traceStages,
            fixtureRawSha256:
              "7682ddd6cbd1539d452a51e1dc0443756959adca780f0b74d2f7f9a3098a73d7",
            currentRawSha256: createHash("sha256")
              .update(originalRaw)
              .digest("hex"),
            receiptSource: "synthetic offline receipt bound to fresh test IDs",
            publicOutput:
              expectedMode === "baseline"
                ? "empty native message"
                : "22 captured stdout bytes",
          }) +
          "\n",
      );
      return;
    }
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
            name: nativePython ? "execute_python" : "fusion_mcp_execute",
            arguments: nativePython
              ? { code: sourceCode, persistent: false }
              : {
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
    if (
      nativePython &&
      !["native-legacy-python", "native-wire-empty"].includes(responseMode)
    ) {
      assert.equal(
        result.job.state,
        "needs_reconciliation",
        JSON.stringify(result),
      );
      assert.equal(productCalls, 1, "Never replay an untrusted public result");
      const directory = path.join(dir, "jobs", job.id);
      const received = fs
        .readdirSync(directory)
        .filter((name) => name.startsWith("received-response-"))
        .map((name) =>
          JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")),
        )
        .find((value) => value.binding?.sourceHash === sourceHash);
      assert.equal(
        received.response.raw,
        originalRaw,
        "Keep the actual native response immutable",
      );
      return;
    }
    if (nativePython) {
      assert.equal(result.job.state, "succeeded", JSON.stringify(result));
      assert.equal(productCalls, 1);
      assert.ok(
        realChecks >= 3,
        "The real checker must certify preflight, adapted public Python and postflight",
      );
      const files = fs
        .readdirSync(path.join(dir, "jobs", job.id))
        .filter((name) => /^rpc-.*\.json$/.test(name));
      const records = files.map((name) =>
        JSON.parse(
          fs.readFileSync(path.join(dir, "jobs", job.id, name), "utf8"),
        ),
      );
      assert.equal(
        records.filter(
          (record) =>
            record.binding?.sourceHash === sourceHash &&
            record.terminal === true,
        ).length,
        1,
      );
      const response = await request<{ rpc: { raw: string } }>(dir, {
        action: "result",
        auth,
        jobId: job.id,
      });
      const publicResult = JSON.parse(response.rpc.raw).result;
      assert.equal(publicResult.isError, false);
      assert.deepEqual(JSON.parse(publicResult.content[0].text), {
        success: true,
        stdout: "FUSION_ADDIN_STDIO_OK\n",
        stderr: "",
      });
      const product = records.find(
        (record) => record.binding?.sourceHash === sourceHash,
      );
      const retained = JSON.parse(
        fs.readFileSync(
          path.join(
            dir,
            "jobs",
            job.id,
            `received-response-${product.binding.rpcId}.json`,
          ),
          "utf8",
        ),
      );
      assert.equal(
        JSON.parse(retained.response.raw).result.isError,
        undefined,
        "Do not rewrite native received-response evidence to match the public contract",
      );
      return;
    }
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
