import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { FmcadServices } from "../src/api";
import type { Client } from "../src/queue-broker-ports";
const load = createRequire(
  path.join(process.cwd(), "tests/brep-baseline-service.test.ts"),
);
function objectValue(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function partial<T extends object>(value: Partial<T>): T {
  return new Proxy(value, {
    get(target, key) {
      assert.ok(
        Reflect.has(target, key) ||
          [
            "prepareCallTool",
            "prepareUiGuardedScript",
            "prepareListTools",
            "preparePost",
            "withRequest",
            "reqOpts",
            "capabilities",
            "serverInfo",
            "negotiatedProtocolVersion",
          ].includes(String(key)),
        `Unexpected fixture access: ${String(key)}`,
      );
      return Reflect.get(target, key);
    },
  }) as T;
}
interface BrepOutput {
  success: boolean;
  operation: string;
  jobId?: string;
  result: {
    status: string;
    precision: string;
    bodyPayloads: { bytes: number; sha256: string }[];
    baseline: unknown;
    manifest: { source: { version: string } };
    passed: boolean;
    geometryEqual: boolean;
    poseEqual: boolean;
  };
}
function brepOutput(value: unknown): BrepOutput {
  const output = objectValue(value);
  assert.equal(typeof output["success"], "boolean");
  assert.equal(typeof output["operation"], "string");
  objectValue(output["result"]);
  return output as unknown as BrepOutput;
}
interface McpOutput {
  error?: unknown;
  result: {
    structuredContent: BrepOutput;
    _meta?: { fmcad?: { jobId?: string } };
  };
}

const { main: cliMain } = load("../src/cli") as {
  main(
    words: string[],
    ports: {
      loadConfig(): unknown;
      stdout: { write(text: string): void };
      stderr: { write(text: string): void };
      setExitCode(): void;
    },
  ): Promise<number>;
};
const { executeInvocation } = load(
  "../src/catalog/execute",
) as typeof import("../src/composition/catalog-execution");
const { contracts, mcpTools, mcpInvocation, validateInvocation, cliContracts } =
  load(
    "../src/catalog",
  ) as typeof import("../src/composition/library-catalog-registry");
const { cadBundleManifest } = load(
  "../packages/node-adapters/dist/python/bundle",
) as typeof import("../packages/node-adapters/src/python/bundle");
const { resolveFmcadConfiguration, id: identity } = load(
  "../src/dist/core",
) as typeof import("../packages/core/src");
const { createFmcad } = load("../src/dist/api") as typeof import("../src/api");
const { createMcpApplication } = load(
  "../src/dist/entrypoints/mcp",
) as typeof import("../src/entrypoints/mcp");
const { serve } = load(
  "../src/queue-broker",
) as typeof import("../src/queue-broker");
const { queueDirectory } = load("../src/queue-connection") as {
  queueDirectory(): string;
};
const { durable } = load("../src/queue-instance") as {
  durable(path: string, value: unknown): void;
};

const context = {
  doc: "Synthetic",
  docId: "scratch-creation",
  docFileId: "scratch-file",
};
const data = {
  bodies: [
    {
      role: "housing",
      body: { kind: "body", token: "body-token-a", name: "Housing" },
    },
    {
      role: "shaft",
      body: { kind: "body", token: "body-token-b", name: "Shaft" },
    },
  ],
  frame: "assembly",
  scope: "durable",
  workBudgetMs: 30000,
};
const pose = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const manifest = {
  version: 1,
  scope: "durable",
  source: { document: "scratch-file", version: "7" },
  frame: "assembly",
  bodies: [
    {
      role: "housing",
      body: "body-token-a",
      instance: "occurrence:Root:1",
      pose,
    },
    {
      role: "shaft",
      body: "body-token-b",
      instance: "occurrence:Root:1",
      pose,
    },
  ],
};
const tolerances = {
  volume: "0.001 mm^3",
  length: "0.001 mm",
  angle: "0.001 deg",
};

function fixture(t: import("node:test").TestContext, enterProject = false) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-brep-coordinator-"),
  );
  const previous = process.cwd();
  if (enterProject) process.chdir(root);
  t.after(() => {
    if (enterProject) process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("canonical catalog, typed CLI/MCP project the same three public operations and hide internal turns", () => {
  const publicIds = [
    "measure.baseline.capture",
    "measure.baseline.inspect",
    "measure.baseline.compare",
  ];
  for (const id of publicIds) {
    assert.equal(contracts[id]!.service.handler, "brep-baseline");
    assert.ok(
      mcpTools.some((tool) => tool._meta.fmcad.operation === id),
      id,
    );
    assert.equal(cliContracts([])[id]!.operation, id);
  }
  assert.equal(
    mcpTools.some((tool) => tool._meta.fmcad.operation.endsWith("_internal")),
    false,
  );
  assert.equal(
    Object.keys(cliContracts([])).some((operation) =>
      operation.endsWith("_internal"),
    ),
    false,
  );
  for (const operation of [
    "measure.baseline.capture_internal",
    "measure.baseline.compare_internal",
  ]) {
    assert.throws(
      () =>
        validateInvocation({ version: 1, kind: "cad", operation, data: {} }),
      /Unknown CAD operation/,
    );
  }
  const cad = load(
    "../src/cad",
  ) as typeof import("../src/composition/cad-execution");
  assert.throws(
    () =>
      cad.validateCad("measure.baseline.capture_internal", {
        bodies: data.bodies,
        frame: data.frame,
        scope: "durable",
        _trustedBinding: {
          version: 1,
          session: "forged",
          stagePaths: ["/tmp/forged.smt"],
          maxBytes: 1024,
          workBudgetMs: 1000,
        },
      }),
    /owned coordinator capability/,
  );
  assert.throws(
    () =>
      validateInvocation({
        version: 1,
        kind: "cad",
        operation: "measure.baseline.capture",
        doc: "Synthetic",
        data,
      }),
    /doc-id or --doc-file-id/,
  );
  assert.equal(
    mcpInvocation("fmcad_cad_measure_baseline_capture", {
      ...context,
      data,
    }).operation,
    "measure.baseline.capture",
  );
  assert.ok(
    cadBundleManifest.some((unit) => unit.id === "measure-baseline-domain"),
  );
  assert.ok(
    cadBundleManifest.some((unit) => unit.id === "measure-baseline-fusion"),
  );
  assert.ok(
    cadBundleManifest.some(
      (unit) => unit.id === "measure-baseline-application",
    ),
  );
});

// Capture and compare each run the production Python checker before one SDK turn.
// The retained admission measurements are 67–74 seconds per generated program;
// a five-second command budget tests premature cancellation, not this lifecycle.
const brokerCommandTimeoutMs = 180000;
test(
  "typed CLI and MCP execute capture → owned inspect → compare through the fake broker",
  { timeout: 2 * brokerCommandTimeoutMs + 30000 },
  async (t) => {
    t.after(load("./fixtures/fake-wsl-platform.cjs")());
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-brep-broker-"));
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    fs.mkdirSync(project);
    const previousCwd = process.cwd();
    const oldState = process.env["XDG_STATE_HOME"];
    process.chdir(project);
    process.env["XDG_STATE_HOME"] = state;
    const apis: FmcadServices[] = [];
    const trace = (phase: string) =>
      process.stderr.write(`[BREP lifecycle] ${phase}\n`);
    let broker: Awaited<ReturnType<typeof serve>> | undefined = undefined;
    const nativeCalls: { operation: string; stagePaths: string[] }[] = [];
    const instance = {
      pid: 99,
      birth: "fake:99",
      version: "fake-fusion",
      activeCommand: "SelectCommand",
      documents: [
        { id: "scratch-creation", fileId: "scratch-file", name: "Synthetic" },
      ],
      documentState: {
        status: "complete",
        fingerprint: "fixture-document",
        state: {
          identity: {
            creationId: "scratch-creation",
            fileId: "scratch-file",
            name: "Synthetic",
            version: 7,
          },
          references: [],
        },
      },
    };
    const fakeBackend: Partial<Client> = {
      server: { timeoutMs: brokerCommandTimeoutMs },
      _parse: JSON.parse,
      async _post(envelope) {
        const request = objectValue(envelope.params?.["arguments"]);
        const requestObject = objectValue(request["object"]);
        const script = requestObject["script"];
        assert.equal(typeof script, "string");
        if (typeof script !== "string") throw new Error("missing script");
        let receiptSource = script,
          binding,
          receiptFile;
        for (let depth = 0; depth < 8; depth++) {
          binding = receiptSource.match(
            /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/,
          );
          receiptFile = receiptSource.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
          if (binding && receiptFile) break;
          const wrapped = receiptSource.match(
            /exec\(compile\(("(?:\\.|[^"\\])*")/,
          );
          if (!wrapped) break;
          receiptSource = JSON.parse(wrapped[1]!);
        }
        assert.ok(
          binding && receiptFile,
          "fake backend must acknowledge the exact current receipt binding",
        );
        const record = JSON.parse(JSON.parse(binding[1]!));
        const target = JSON.parse(receiptFile[1]!)
          .replace(/^\\\\wsl\$\\[^\\]+/, "")
          .replaceAll("\\", "/");
        durable(target, {
          ...record,
          terminal: true,
          outcome: "succeeded",
          instance,
        });
        if (script.includes("FMCAD_QUEUE_INSTANCE")) {
          const text = "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance);
          return {
            status: 200,
            raw: JSON.stringify({
              jsonrpc: "2.0",
              id: envelope.id,
              result: { content: [{ type: "text", text }] },
            }),
          };
        }
        assert.match(script, /class BrepBaselineService/);
        assert.match(script, /class FusionExactBrepSerializer/);
        assert.match(script, /_measure_baseline_internal_handler/);
        assert.ok(requestObject["readOnly"]);
        const stageId = fs.readdirSync(
          path.join(project, ".cad/baseline-staging"),
        )[0];
        assert.ok(stageId);
        const stageDir = path.join(project, ".cad/baseline-staging", stageId);
        const entries = fs.readdirSync(stageDir);
        const op =
          entries.length === 0
            ? "measure.baseline.capture_internal"
            : "measure.baseline.compare_internal";
        const stagePaths = [0, 1].map((index) =>
          path.join(stageDir, `${index}.smt`),
        );
        nativeCalls.push({ operation: op, stagePaths });
        assert.ok(script.includes(JSON.stringify(op)) || script.includes(op));
        if (op.endsWith("capture_internal")) {
          for (const [index, stagePath] of stagePaths.entries()) {
            fs.writeFileSync(
              stagePath,
              Buffer.from(`fake-exact-brep-${index}`),
              { flag: "wx" },
            );
          }
          const text =
            "FMCAD_RESULT " +
            JSON.stringify({
              success: true,
              operation: op,
              result: {
                status: "pass",
                precision: "exact",
                manifest,
                stagedPayloadCount: 2,
              },
            });
          return {
            status: 200,
            raw: JSON.stringify({
              jsonrpc: "2.0",
              id: envelope.id,
              result: { content: [{ type: "text", text }] },
            }),
          };
        }
        assert.deepEqual(
          stagePaths.map((file) => fs.readFileSync(file).toString()),
          ["fake-exact-brep-0", "fake-exact-brep-1"],
        );
        const text =
          "FMCAD_RESULT " +
          JSON.stringify({
            success: true,
            operation: op,
            result: {
              status: "pass",
              passed: true,
              precision: "exact",
              geometryEqual: true,
              poseEqual: true,
              bodies: manifest.bodies.map((body) => ({
                role: body.role,
                volumeEqual: true,
                poseEqual: true,
              })),
            },
          });
        return {
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: envelope.id,
            result: { content: [{ type: "text", text }] },
          }),
        };
      },
      async callTool(value) {
        const response = await this._post!({
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "tools/call",
          params: { name: "fusion_mcp_execute", arguments: value },
        });
        return {
          failed: false,
          text: JSON.parse(response.raw).result.content[0].text,
        };
      },
    };
    const config = resolveFmcadConfiguration({
      adapter: {
        backend: "mcp",
        routing: "queue",
        url: "http://127.0.0.1:8765/mcp",
        timeoutMs: brokerCommandTimeoutMs,
        headers: {},
      },
      environment: {},
      file: {},
      platformDefaults: {},
      acceptedService: null,
    });
    const brokerDirectory = queueDirectory();
    t.after(async () => {
      trace("cleanup: disposing clients");
      for (const api of apis) await api.dispose();
      trace("cleanup: draining broker");
      await broker?.close();
      trace("cleanup: broker drained");
      process.chdir(previousCwd);
      if (oldState === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = oldState;
      fs.rmSync(root, { recursive: true, force: true });
    });
    const preload = path.join(root, "fake-wsl-preload.cjs");
    fs.writeFileSync(
      preload,
      `require(${JSON.stringify(load.resolve("./fixtures/fake-wsl-platform.cjs"))})();\n`,
    );
    broker = await serve(
      { ...config },
      {
        dir: brokerDirectory,
        confirmOwnership: true,
        createBackend: () => partial<Client>(fakeBackend),
        pollMs: 5,
        spawnWorker: ((
          executable: string,
          args: readonly string[] = [],
          options: import("node:child_process").SpawnOptions = {},
        ) => {
          const worker = (
            load("node:child_process") as typeof import("node:child_process")
          ).spawn(executable, ["--require", preload, ...args], options);
          trace("worker spawned");
          worker.once("close", (code: number | null, signal: string | null) =>
            trace(`worker closed code=${code} signal=${signal}`),
          );
          return worker;
        }) as typeof import("node:child_process").spawn,
      },
    );

    trace("capture: starting CLI");
    let cliOutput = "",
      cliErrors = "";
    const cliCode = await cliMain(
      [
        "measure",
        "baseline",
        "capture",
        "--doc",
        context.doc,
        "--doc-id",
        context.docId,
        "--doc-file-id",
        context.docFileId,
        "--data",
        JSON.stringify(data),
        "--json",
      ],
      {
        loadConfig: () => ({ cfg: config }),
        stdout: {
          write: (value) => {
            cliOutput += value;
          },
        },
        stderr: {
          write: (value) => {
            cliErrors += value;
          },
        },
        setExitCode: () => {},
      },
    );
    trace(`capture: CLI returned ${cliCode}`);
    assert.equal(cliCode, 0, cliErrors);
    const captured: BrepOutput = JSON.parse(cliOutput);
    assert.equal(captured.success, true);
    assert.equal(captured.operation, "measure.baseline.capture");
    assert.equal(captured.result.status, "pass");
    assert.equal(captured.result.precision, "exact");
    assert.equal(captured.result.bodyPayloads.length, 2);
    assert.equal(nativeCalls.length, 1);
    assert.equal(nativeCalls[0]!.stagePaths.length, 2);
    assert.deepEqual(
      fs.readdirSync(path.join(project, ".cad/baseline-staging")),
      [],
    );

    const mcp = createMcpApplication({
      services(local, mcpContext) {
        assert.ok(mcpContext);
        const api = createFmcad({
          version: 1,
          config,
          context: {
            ...mcpContext,
            clientId: mcpContext.clientId || "brep-mcp-test",
            instanceId:
              Reflect.get(mcpContext, "instanceId") || "brep-mcp-instance",
            source: "mcp",
            projectDirectory: mcpContext.projectDirectory || project,
          },
        });
        apis.push(api);
        return api;
      },
      clientContext: {
        identity: {
          clientId: identity("client", "brep-mcp-test"),
          instanceId: identity("instance", "brep-mcp-instance"),
          sessionId: identity("session", "brep-mcp-session"),
        },
        resolveProject: async (selection) => ({
          projectDirectory: selection.projectDirectory || project,
          source: selection.projectDirectory ? "explicit" : "none",
        }),
      },
      compatibility: async () =>
        assert.fail(
          "BRep application calls must not use the legacy backend proxy",
        ),
      queueTools: [],
    });
    const mcpCall = async (
      id: string,
      operation: string,
      requestData: unknown,
      requestContext = {},
    ): Promise<BrepOutput> => {
      const response = await mcp({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "fmcad_execute",
          arguments: {
            operation,
            data: requestData,
            context: {
              ...requestContext,
            },
          },
          _meta: { fmcad: { projectDirectory: project } },
        },
      });
      const parsed: McpOutput = JSON.parse(response.raw);
      assert.equal(parsed.error, undefined, JSON.stringify(parsed));
      const value = parsed.result.structuredContent;
      const jobId = value.jobId || parsed.result._meta?.fmcad?.jobId;
      if (!jobId) return value;
      const api = apis.at(-1);
      assert.ok(api);
      for (let attempt = 0; attempt < 1000; attempt++) {
        const receipt = await api.query.result(jobId);
        if (
          [
            "succeeded",
            "failed",
            "cancelled",
            "expired",
            "needs_reconciliation",
          ].includes(receipt.state)
        )
          return brepOutput(receipt.result ?? receipt);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`MCP baseline job ${jobId} did not settle`);
    };
    trace("inspect: starting MCP");
    const inspected = await mcpCall("inspect", "measure.baseline.inspect", {
      baseline: captured.result.baseline,
    });
    assert.equal(inspected.success, true);
    assert.equal(inspected.result.manifest.source.version, "7");
    assert.deepEqual(
      inspected.result.bodyPayloads.map((row) => row.bytes),
      [17, 17],
    );
    assert.ok(
      inspected.result.bodyPayloads.every((row) =>
        /^[a-f0-9]{64}$/.test(row.sha256),
      ),
    );

    const compareInput = mcpInvocation("fmcad_cad_measure_baseline_compare", {
      ...context,
      data: {
        baseline: captured.result.baseline,
        bodies: data.bodies,
        tolerances,
      },
    }).invocation;
    trace("compare: starting MCP");
    const compared = await mcpCall(
      "compare",
      "measure.baseline.compare",
      compareInput.data,
      {
        doc: context.doc,
        docId: context.docId,
        docFileId: context.docFileId,
      },
    );
    trace("compare: returned");
    assert.equal(compared.success, true);
    assert.equal(compared.result.passed, true);
    assert.equal(compared.result.geometryEqual, true);
    assert.equal(compared.result.poseEqual, true);
    assert.equal(nativeCalls.length, 2);
    assert.deepEqual(
      fs.readdirSync(path.join(project, ".cad/baseline-staging")),
      [],
    );
  },
);

test("unknown fake-broker outcome retains one owned staging turn and never replays", async (t) => {
  t.after(load("./fixtures/fake-wsl-platform.cjs")());
  const root = fixture(t, true);
  let turns = 0;
  const input = mcpInvocation("fmcad_cad_measure_baseline_capture", {
    ...context,
    data,
  }).invocation;
  await assert.rejects(
    () =>
      executeInvocation(input, {
        callTool: async () => {
          turns++;
          throw new Error("unknown transport outcome");
        },
      }),
    /unknown transport outcome/,
  );
  assert.equal(turns, 1);
  const stages = fs.readdirSync(path.join(root, ".cad/baseline-staging"));
  assert.equal(stages.length, 1);
  assert.equal(
    fs.readdirSync(path.join(root, ".cad/baseline-staging", stages[0]!)).length,
    0,
  );
});
