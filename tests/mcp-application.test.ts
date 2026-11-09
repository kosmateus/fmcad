import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import type { McpRequest } from "../src/entrypoints/mcp";
import type {
  FmcadServices,
  CadWorkerInvocation,
  ExecuteOptions,
  ExecutionReceipt,
} from "../src/api";
import type { Client } from "../src/queue-broker-ports";
import type { BrokerModules } from "../src/queue-broker-modules";
const root = process.cwd(),
  load = createRequire(__filename);
const { id } = load(
  path.join(root, "src/dist/core"),
) as typeof import("../packages/core/src");
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function field(value: unknown, ...keys: string[]): unknown {
  return keys.reduce((v, k) => object(v)[k], value);
}
function optional(value: unknown, ...keys: string[]): unknown {
  return keys.reduce(
    (v, k) =>
      v !== null && typeof v === "object" ? Reflect.get(v, k) : undefined,
    value,
  );
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
function partial<T extends object>(value: Partial<T>): T {
  return new Proxy(value, {
    get(target, key) {
      assert(
        Reflect.has(target, key),
        `Unexpected fixture access: ${String(key)}`,
      );
      return Reflect.get(target, key);
    },
  }) as T;
}
function services(
  value: Partial<Omit<FmcadServices, "query">> & {
    query?: Partial<FmcadServices["query"]>;
  },
): FmcadServices {
  return partial<FmcadServices>({
    ...value,
    ...(value.query
      ? { query: partial<FmcadServices["query"]>(value.query) }
      : {}),
  } as Partial<FmcadServices>);
}
function outcome(
  executionOutcome: ExecutionReceipt["outcome"]["executionOutcome"],
): ExecutionReceipt["outcome"] {
  return {
    version: 1,
    requestId: null,
    jobId: null,
    acceptance: "accepted",
    executionOutcome,
    mayHaveMutated: null,
    code: null,
    validation: {
      status: "not_checked",
      source: null,
      artifactId: null,
      measurements: {},
    },
  };
}
interface PublicJob {
  id: string;
  requestId?: unknown;
  state?: unknown;
  [key: string]: unknown;
}
function publicJobs(broker: { status(): unknown }): PublicJob[] {
  return Object.values(object(field(broker.status(), "jobs"))).map((value) => {
    const result = object(value);
    assert.equal(typeof result["id"], "string");
    return result as unknown as PublicJob;
  });
}

// Match the public library budget: real worker admission checks both the original
// Python artifact and receipt wrappers before the fake physical backend runs.
const publicExecutionBudgetMs = 180000;
function receiptFromPreparedScript(script: string) {
  let source = script;
  for (let depth = 0; depth < 8; depth++) {
    const binding = source.match(
      /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/,
    );
    const file = source.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
    if (binding && file)
      return {
        record: object(JSON.parse(JSON.parse(binding[1]!))),
        target: JSON.parse(file[1]!)
          .replace(/^\\\\wsl\$\\[^\\]+/, "")
          .replaceAll("\\", "/"),
      };
    const wrapped = source.match(/exec\(compile\(("(?:\\.|[^"\\])*")/);
    if (!wrapped) break;
    source = JSON.parse(wrapped[1]!);
  }
  assert.fail(
    "The physical test backend requires an exact prepared receipt binding and path",
  );
}

test("MCP physical fixture reads current prepared receipt wrappers and rejects missing bindings", () => {
  const { prepareReceiptScript } = load(
    path.join(root, "src/queue-instance"),
  ) as BrokerModules["./queue-instance"];
  const binding = {
    rpcId: "receipt-rpc",
    requestHash: "a".repeat(64),
    buildHash: "b".repeat(64),
    requestId: "receipt-request",
    jobId: "receipt-job",
    marker: 'quoted " value',
  };
  const receiptPath = "/tmp/mcp-receipt.json";
  for (const official of [false, true]) {
    const prepared = prepareReceiptScript(
      "pass\n",
      official,
      receiptPath,
      binding,
      { mapPath: (value) => value },
    );
    assert.deepEqual(receiptFromPreparedScript(prepared.script), {
      record: binding,
      target: receiptPath,
    });
  }
  assert.throws(
    () => receiptFromPreparedScript("pass\n"),
    /exact prepared receipt/,
  );
});

function processClient(
  t: TestContext,
  entrypoint: string,
  directory: string,
  extra: NodeJS.ProcessEnv = {},
  executable = false,
) {
  const env = {
    ...process.env,
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    XDG_STATE_HOME: directory,
    FMCAD_CONFIG: path.join(directory, "config.json"),
    FMCAD_BACKEND: "addin",
    FMCAD_ROUTING: "queue",
    FMCAD_PROJECT_DIRECTORY: directory,
    ...extra,
  };
  const child = spawn(
    executable ? entrypoint : process.execPath,
    executable ? [] : [entrypoint],
    { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  let diagnostics = "",
    output = "";
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const lines = readline
    .createInterface({ input: child.stdout })
    [Symbol.asyncIterator]();
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await closed;
    }
  });
  return {
    child,
    diagnostics: () => diagnostics,
    output: () => output,
    notify(value: unknown) {
      child.stdin.write(JSON.stringify(value) + "\n");
    },
    async request(value: unknown): Promise<unknown> {
      child.stdin.write(
        typeof value === "string" ? value + "\n" : JSON.stringify(value) + "\n",
      );
      const line = await lines.next();
      assert.equal(line.done, false, diagnostics);
      return JSON.parse(line.value!) as unknown;
    },
    async close() {
      child.stdin.end();
      assert.deepEqual(await closed, [0, null], diagnostics);
      assert.equal((await lines.next()).done, true);
      assert.equal(diagnostics, "");
    },
    async kill(signal: NodeJS.Signals = "SIGKILL") {
      child.kill(signal);
      await closed;
    },
  };
}
const request = (
  id: string | number,
  method: string,
  params?: Record<string, unknown>,
): McpRequest => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
});
const execute = (
  id: string | number,
  operation: string,
  data: unknown = {},
  context: unknown = {},
  meta?: unknown,
) =>
  request(id, "tools/call", {
    name: "fmcad_execute",
    arguments: { operation, data, context },
    ...(meta ? { _meta: { fmcad: meta } } : {}),
  });
async function until<T>(
  fn: () => T | Promise<T>,
  message: string,
  timeoutMs = 10000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for " + message);
}

test("typed MCP adapter preserves pins, purpose and request identity across aliases without replay", async () => {
  const { createMcpApplication } = load(
    path.join(root, "src/dist/entrypoints/mcp"),
  ) as typeof import("../src/entrypoints/mcp");
  let submissions = 0,
    starts = 0,
    observed:
      { payload: CadWorkerInvocation; options: ExecuteOptions } | undefined;
  const application = createMcpApplication({
    queueTools: [],
    compatibility() {
      assert.fail("not a physical RPC");
    },
    services(local) {
      assert.equal(local, false);
      return services({
        async start() {
          starts++;
        },
        async execute(payload, options) {
          submissions++;
          observed = { payload, options };
          return {
            version: 1,
            requestId: options.requestId,
            jobId: "owned-job",
            state: "running",
            result: null,
            outcome: outcome("unknown"),
          };
        },
        query: {
          async result() {
            throw new Error(
              "Lost observation; remote execution may still be active",
            );
          },
        },
      });
    },
  });
  const response = JSON.parse(
    (
      await application(
        execute(
          0,
          "entity.list",
          {},
          {
            doc: "Model",
            docId: "creation",
            docFileId: "file",
            component: "root",
            projectId: "project",
          },
          { description: "Inspect part", requestId: "stable-owned-request" },
        ),
      )
    ).raw,
  );
  assert.equal(submissions, 1);
  assert.equal(starts, 1);
  assert.deepEqual(observed, {
    payload: {
      version: 1,
      kind: "cad",
      operation: "entity.list",
      data: {},
      doc: "Model",
      docId: "creation",
      docFileId: "file",
      component: "root",
      projectId: "project",
      purpose: "Inspect part",
    },
    options: { requestId: "stable-owned-request" },
  });
  assert.equal(response.id, 0);
  assert.equal(field(response, "error", "data", "fmcad", "jobId"), "owned-job");
  assert.equal(
    field(response, "error", "data", "requestId"),
    "stable-owned-request",
  );
  assert.match(
    text(field(response, "error", "data", "instruction")),
    /do not resubmit/,
  );
  const alias = request("alias", "tools/call", {
    name: "fmcad_cad_entity_list",
    arguments: {
      data: {},
      doc: "Model",
      docId: "creation",
      docFileId: "file",
      purpose: "Inspect part",
    },
  });
  await application(alias);
  assert.equal(
    submissions,
    2,
    "each explicit call has one submit; observation failure never replays",
  );
  assert(observed);
  assert.equal(field(observed.payload, "docId"), "creation");
});

test("MCP rejects missing project scope before admission with typed required validation", async () => {
  const { createMcpApplication } = load(
    path.join(root, "src/dist/entrypoints/mcp"),
  ) as typeof import("../src/entrypoints/mcp");
  let projectResolution: unknown;
  const application = createMcpApplication({
    queueTools: [],
    clientContext: {
      identity: {
        clientId: id("client", "owner-a"),
        instanceId: id("instance", "presence-a"),
        sessionId: id("session", "session-a"),
      },
      async resolveProject(selection) {
        projectResolution = selection;
        return { projectDirectory: null, source: "none" };
      },
    },
    services() {
      assert.fail("missing project must reject before constructing services");
    },
    compatibility() {
      assert.fail("native validation must not enter raw compatibility");
    },
  });
  const result = JSON.parse(
    (
      await application(
        execute(
          "no-project",
          "entity.list",
          {},
          { doc: "Model" },
          {
            requestId: "missing-project-request",
          },
        ),
      )
    ).raw,
  );
  assert.deepEqual(projectResolution, {});
  assert.equal(result.error.data.requestId, "missing-project-request");
  assert.equal(result.error.data.requestStatus, "rejected-before-admission");
  assert.equal(result.error.data.validation.status, "required");
  assert.equal(result.error.data.context.projectDirectory, null);
});

test("queue helper invalid input and unsupported methods fail before configuration or transport", async () => {
  const { createMcpApplication } = load(
    path.join(root, "src/dist/entrypoints/mcp"),
  ) as typeof import("../src/entrypoints/mcp");
  const queueTools = (
    [
      ["begin", []],
      ["end", ["sequenceId"]],
      ["result", ["jobId"]],
    ] as [string, string[]][]
  ).map(([name, required]) => ({
    name: "fmcad_queue_" + name,
    inputSchema: { required },
  }));
  const application = createMcpApplication({
    queueTools,
    services() {
      assert.fail("no application effect");
    },
    compatibility() {
      assert.fail("no compatibility effect");
    },
  });
  for (const [name, args] of [
    ["fmcad_queue_result", { jobId: "" }],
    ["fmcad_queue_begin", { unknown: true }],
    ["fmcad_queue_end", {}],
    ["fusion_mcp_execute", { code: "wrong schema" }],
  ] as [string, Record<string, unknown>][]) {
    const value = JSON.parse(
      (
        await application(
          request(name, "tools/call", { name, arguments: args }),
        )
      ).raw,
    );
    assert.equal(field(value, "error", "code"), -32602);
  }
  for (const method of [
    "resources/read",
    "resources/subscribe",
    "prompts/list",
    "prompts/get",
    "not/a/method",
  ]) {
    assert.equal(
      JSON.parse((await application(request(method, method))).raw).error.code,
      -32601,
    );
  }
});

test("queue helper forwards a schema-declared optional outcome and rejects other values", async () => {
  const { createMcpApplication } = load(
    path.join(root, "src/dist/entrypoints/mcp"),
  ) as typeof import("../src/entrypoints/mcp");
  const queueTools = [
    {
      name: "fmcad_queue_reconcile",
      inputSchema: {
        required: ["jobId"],
        properties: {
          jobId: { type: "string" },
          acceptedOutcome: { type: "string", enum: ["committed", "aborted"] },
        },
      },
    },
  ];
  let forwarded: McpRequest | undefined;
  const application = createMcpApplication({
    queueTools,
    services() {
      assert.fail("queue helper must not construct a CAD service");
    },
    async compatibility(request) {
      forwarded = request;
      return {
        status: 200,
        raw: JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }),
      };
    },
  });
  const valid = request("valid-outcome", "tools/call", {
    name: "fmcad_queue_reconcile",
    arguments: { jobId: "job-1", acceptedOutcome: "committed" },
  });
  assert.equal(
    JSON.parse((await application(valid)).raw).result !== undefined,
    true,
  );
  assert.deepEqual(
    field(forwarded, "params", "arguments"),
    field(valid, "params", "arguments"),
  );
  const invalid = request("invalid-outcome", "tools/call", {
    name: "fmcad_queue_reconcile",
    arguments: { jobId: "job-1", acceptedOutcome: "unknown" },
  });
  assert.equal(JSON.parse((await application(invalid)).raw).error.code, -32602);
});

test("MCP stops waiting for a slow observation without replay or terminal-success fabrication", async () => {
  const { createMcpApplication } = load(
    path.join(root, "src/dist/entrypoints/mcp"),
  ) as typeof import("../src/entrypoints/mcp");
  let submissions = 0,
    state = "preparing";
  const application = createMcpApplication({
    queueTools: [],
    compatibility() {
      assert.fail("no raw proxy");
    },
    services() {
      return services({
        async start() {},
        async execute(payload, options) {
          submissions++;
          return {
            version: 1,
            requestId: options.requestId,
            jobId: "bounded-job",
            state,
            result: null,
            outcome: outcome(state === "failed" ? "failed" : "not_started"),
          };
        },
        query: {
          result() {
            return new Promise(() => {});
          },
        },
      });
    },
  });
  const before = Date.now();
  const accepted = JSON.parse(
    (await application(execute(1, "entity.list", {}, { doc: "Model" }))).raw,
  );
  assert(
    Date.now() - before < 2000,
    "a stuck result read must not extend the synchronous acceptance window",
  );
  assert.equal(accepted.result.structuredContent.status, "ACCEPTED");
  assert.equal(accepted.result.structuredContent.state, "preparing");
  assert.equal(submissions, 1);
  state = "failed";
  const failed = JSON.parse(
    (await application(execute(2, "entity.list", {}, { doc: "Model" }))).raw,
  );
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.structuredContent.status, undefined);
  state = "succeeded";
  const missing = JSON.parse(
    (await application(execute(3, "entity.list", {}, { doc: "Model" }))).raw,
  );
  assert.match(missing.error.message, /QUEUE_RESULT_UNAVAILABLE/);
  assert.equal(missing.error.data.fmcad.jobId, "bounded-job");
  assert.equal(
    submissions,
    3,
    "each explicit test call submits once, never on observation failure",
  );
});

test("explicit raw compatibility adapters preserve wire arguments and never promote arbitrary backend tool names", async () => {
  const { createMcpApplication } = load(
    path.join(root, "src/dist/entrypoints/mcp"),
  ) as typeof import("../src/entrypoints/mcp");
  const seen: McpRequest[] = [];
  const application = createMcpApplication({
    queueTools: [],
    services() {
      assert.fail("not native CAD");
    },
    async compatibility(value) {
      seen.push(value);
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: value.id,
          result: { content: [] },
        }),
      };
    },
  });
  const raw = request(4, "tools/call", {
    name: "fusion_mcp_execute",
    arguments: {
      featureType: "script",
      object: { script: 'print("unchanged")', readOnly: true },
    },
  });
  assert(JSON.parse((await application(raw)).raw).result);
  assert.deepEqual(seen, [raw]);
  const unknown = JSON.parse(
    (
      await application(
        request(5, "tools/call", {
          name: "arbitrary_upstream_sdk_schema",
          arguments: {},
        }),
      )
    ).raw,
  );
  assert.equal(unknown.error.code, -32602);
  assert.equal(seen.length, 1);
});

test(
  "process MCP and CLI share the production broker/typed worker and execute once per explicit request",
  { timeout: 390000 },
  async (t) => {
    t.after(
      (
        load(
          path.join(root, "tests/fixtures/fake-wsl-platform.cjs"),
        ) as () => () => void
      )(),
    );
    const { resolveFmcadConfiguration } = load(
      path.join(root, "dist/src/dist/core"),
    ) as typeof import("../packages/core/src");
    const { queueDirectory } = load(
      path.join(root, "dist/src/queue-connection"),
    ) as typeof import("../src/entrypoints/queue-connection");
    const { serve } = load(
      path.join(root, "dist/src/queue-broker"),
    ) as typeof import("../src/queue-broker");
    const { durable } = load(
      path.join(root, "dist/src/queue-instance"),
    ) as BrokerModules["./queue-instance"];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-broker-"));
    const oldState = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = directory;
    const dir = queueDirectory();
    const config = {
      ...resolveFmcadConfiguration({
        adapter: {
          backend: "mcp",
          url: "http://localhost:1",
          timeoutMs: publicExecutionBudgetMs,
        },
        environment: {},
        file: {},
        platformDefaults: {},
        acceptedService: null,
      }),
      queue: {
        autoStart: false,
        startupTimeoutMs: 45000,
        waitTimeoutMs: 35000,
        client: "typed-mcp",
      },
      controlCenter: { port: 5481 },
    };
    fs.writeFileSync(
      path.join(directory, "config.json"),
      JSON.stringify(config),
    );
    const instance = {
      pid: 99,
      birth: "mock:99",
      version: "mock",
      activeCommand: "SelectCommand",
      documents: [],
      documentState: {
        status: "complete",
        fingerprint: "unchanged",
        state: {
          identity: { creationId: "creation", fileId: "file" },
          references: [],
        },
      },
    };
    const expected = {
      success: true,
      operation: "document.status",
      result: {
        name: "Model",
        creationId: "creation",
        saved: true,
        modified: false,
        fileId: "file",
        fileName: "Model.f3d",
        version: 1,
        versionId: "version-1",
        isComplete: true,
        folderId: "folder",
        projectId: "project",
      },
    };
    let calls = 0;
    function settle(script: string) {
      const { record, target } = receiptFromPreparedScript(script);
      durable(target, {
        ...record,
        terminal: true,
        outcome: "succeeded",
        instance,
      });
    }
    const physical: Client = partial<Client>({
      capabilities: {},
      server: { timeoutMs: publicExecutionBudgetMs },
      _parse: JSON.parse,
      async _post(payload) {
        calls++;
        settle(text(field(payload, "params", "arguments", "object", "script")));
        return {
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              content: [
                {
                  type: "text",
                  text: "FMCAD_RESULT " + JSON.stringify(expected),
                },
              ],
            },
          }),
        };
      },
      async callTool(value) {
        const script = text(optional(value, "object", "script") ?? "");
        if (script.includes("FMCAD_QUEUE_INSTANCE")) {
          settle(script);
          return {
            failed: false,
            text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance),
          };
        }
        assert(this._post);
        const response = await this._post({
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
    });
    const preload = path.join(directory, "fake-wsl-preload.cjs");
    fs.writeFileSync(
      preload,
      `require(${JSON.stringify(path.join(root, "tests/fixtures/fake-wsl-platform.cjs"))})();\n`,
    );
    const broker = await serve(
      { ...config },
      {
        dir,
        spawnWorker: ((
          executable: string,
          args: readonly string[] = [],
          options: import("node:child_process").SpawnOptions = {},
        ) =>
          spawn(
            executable,
            ["--require", preload, ...args],
            options,
          )) as typeof spawn,
        confirmOwnership: true,
        createBackend: () => physical,
        pollMs: 5,
      },
    );
    t.after(async () => {
      await broker.close();
      if (oldState === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = oldState;
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const env = { FMCAD_BACKEND: "mcp" };
    const client = processClient(
      t,
      path.join(root, "dist/bin/fmcad-mcp.js"),
      directory,
      env,
    );
    async function completed(response: unknown) {
      if (!optional(response, "result", "structuredContent", "jobId"))
        return optional(response, "result", "structuredContent");
      const jobId = field(response, "result", "structuredContent", "jobId");
      for (
        let i = 0, deadline = Date.now() + publicExecutionBudgetMs;
        Date.now() < deadline;
        i++
      ) {
        const value = await client.request(
          request(`poll-${i}`, "tools/call", {
            name: "fmcad_queue_result",
            arguments: { jobId },
          }),
        );
        const result = optional(value, "result", "structuredContent");
        if (
          ["succeeded", "failed"].includes(
            String(optional(result, "job", "state")),
          )
        ) {
          assert.equal(
            field(result, "job", "state"),
            "succeeded",
            JSON.stringify(result),
          );
          return JSON.parse(text(field(result, "stdout")));
        }
        assert(!field(value, "error"), JSON.stringify(value));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail("The existing owned job did not settle");
    }
    const native = await client.request(
      execute(
        1,
        "document.status",
        {},
        {
          doc: "Model",
          docId: "creation",
          docFileId: "file",
          purpose: "Inspect part",
        },
        { requestId: "mcp-stable" },
      ),
    );
    const nativeOutput = await completed(native);
    assert.deepEqual(nativeOutput, expected, JSON.stringify(native));
    assert.equal(calls, 1);
    const jobs = publicJobs(broker);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.requestId, "mcp-stable");
    assert(
      !Object.hasOwn(jobs[0]!, "request"),
      "public broker status must not leak the worker envelope",
    );
    const repeated = await client.request(
      execute(
        2,
        "document.status",
        {},
        {
          doc: "Model",
          docId: "creation",
          docFileId: "file",
          purpose: "Inspect part",
        },
        { requestId: "mcp-stable" },
      ),
    );
    assert.deepEqual(
      await completed(repeated),
      expected,
      JSON.stringify(repeated),
    );
    assert.equal(
      calls,
      1,
      "same explicit request identity is deduplicated by the broker, never replayed",
    );
    const cliChild = spawn(
      process.execPath,
      [
        path.join(root, "dist/bin/fmcad.js"),
        "document",
        "status",
        "--doc",
        "Model",
        "--doc-id",
        "creation",
        "--doc-file-id",
        "file",
        "--json",
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          FMCAD_CONFIG: path.join(directory, "config.json"),
          FMCAD_BACKEND: "mcp",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      errors = "";
    cliChild.stdout.on("data", (chunk) => {
      output += chunk;
    });
    cliChild.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    assert.deepEqual(await once(cliChild, "close"), [0, null], errors);
    assert.deepEqual(JSON.parse(output), nativeOutput);
    assert.equal(
      calls,
      2,
      "one MCP operation and one distinct CLI operation each get one SDK turn",
    );
    await client.close();
  },
);

test(
  "MCP process identities preserve project-scoped jobs across pause, lost acknowledgement and owner restart",
  { timeout: 390000 },
  async (t) => {
    t.after(
      (
        load(
          path.join(root, "tests/fixtures/fake-wsl-platform.cjs"),
        ) as () => () => void
      )(),
    );
    const { resolveFmcadConfiguration } = load(
      path.join(root, "dist/src/dist/core"),
    ) as typeof import("../packages/core/src");
    const { queueDirectory } = load(
      path.join(root, "src/queue-connection"),
    ) as typeof import("../src/entrypoints/queue-connection");
    const { serve } = load(
      path.join(root, "dist/src/queue-broker"),
    ) as typeof import("../src/queue-broker");
    const { durable } = load(
      path.join(root, "dist/src/queue-instance"),
    ) as BrokerModules["./queue-instance"];
    const { QueueClient } = load(
      path.join(root, "src/queue-client"),
    ) as typeof import("../src/queue-client");
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "mcp-context-process-"),
    );
    const projectA = path.join(directory, "project-a");
    const projectB = path.join(directory, "project-b");
    fs.mkdirSync(projectA);
    fs.mkdirSync(projectB);
    const oldState = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = directory;
    const clients: ReturnType<typeof processClient>[] = [];
    const dir = queueDirectory();
    const config = resolveFmcadConfiguration({
      adapter: {
        backend: "mcp",
        url: "http://localhost:1/mcp",
        timeoutMs: publicExecutionBudgetMs,
      },
      environment: {},
      file: {},
      platformDefaults: {},
      acceptedService: null,
    });
    fs.writeFileSync(
      path.join(directory, "config.json"),
      JSON.stringify(config),
    );
    const instance = {
      pid: 99,
      birth: "mock:99",
      version: "mock",
      activeCommand: "SelectCommand",
      documents: [],
      documentState: {
        status: "complete",
        fingerprint: "unchanged",
        state: {
          identity: { creationId: "creation", fileId: "file" },
          references: [],
        },
      },
    };
    const expected = {
      success: true,
      operation: "entity.list",
      result: { entities: [], observed: true },
    };
    let userCalls = 0;
    let releaseFirstCall!: () => void;
    let markFirstCall!: () => void;
    const firstCallStarted = new Promise<void>((resolve) => {
      markFirstCall = resolve;
    });
    const firstCallGate = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    function settle(script: string) {
      const { record, target } = receiptFromPreparedScript(script);
      durable(target, {
        ...record,
        terminal: true,
        outcome: "succeeded",
        instance,
      });
    }
    const physical: Client = partial<Client>({
      capabilities: {},
      server: { timeoutMs: publicExecutionBudgetMs },
      _parse: JSON.parse,
      async _post(payload) {
        userCalls++;
        if (userCalls === 1) {
          markFirstCall();
          await firstCallGate;
        }
        settle(text(field(payload, "params", "arguments", "object", "script")));
        return {
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              content: [
                {
                  type: "text",
                  text: "FMCAD_RESULT " + JSON.stringify(expected),
                },
              ],
            },
          }),
        };
      },
      async callTool(value) {
        const script = text(optional(value, "object", "script") ?? "");
        if (script.includes("FMCAD_QUEUE_INSTANCE")) {
          settle(script);
          return {
            failed: false,
            text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance),
          };
        }
        assert(this._post);
        const response = await this._post({
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
    });
    const preload = path.join(directory, "fake-wsl-preload.cjs");
    fs.writeFileSync(
      preload,
      `require(${JSON.stringify(path.join(root, "tests/fixtures/fake-wsl-platform.cjs"))})();\n`,
    );
    const broker = await serve(
      { ...config },
      {
        dir,
        spawnWorker: ((
          executable: string,
          args: readonly string[] = [],
          options: import("node:child_process").SpawnOptions = {},
        ) =>
          spawn(
            executable,
            ["--require", preload, ...args],
            options,
          )) as typeof spawn,
        confirmOwnership: true,
        createBackend: () => physical,
        pollMs: 5,
      },
    );
    const owner = new QueueClient("owner-a", { cfg: config });
    t.after(async () => {
      releaseFirstCall();
      for (const client of clients) {
        if (client.child.exitCode === null && client.child.signalCode === null)
          await client.kill();
      }
      try {
        let state = object(await owner.call("control-status"));
        const deadline = Date.now() + 10000;
        while (state["phase"] === "PAUSING" && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          state = object(await owner.call("control-status"));
        }
        if (state["phase"] === "PAUSED") {
          await owner.call("resume", {
            control: {
              requestId: "mcp-context-cleanup-resume",
              instanceId: state["instanceId"],
              expectedGeneration: state["generation"],
            },
          });
        }
      } catch {
        /* Preserve the original process-test failure during cleanup. */
      }
      owner.dispose();
      await broker.close();
      if (oldState === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = oldState;
      fs.rmSync(directory, { recursive: true, force: true });
    });
    await owner.register();
    const entrypoint = path.join(root, "dist/bin/fmcad-mcp.js");
    const ownerAEnv = {
      FMCAD_CLIENT: "owner-a",
      FMCAD_BACKEND: "mcp",
      FMCAD_PROJECT_DIRECTORY: projectA,
    };
    const first = processClient(t, entrypoint, directory, ownerAEnv);
    clients.push(first);
    await first.request(
      request("initialize-a", "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "label-is-not-owner", version: "1" },
      }),
    );
    first.notify(
      execute(
        "lost-ack",
        "entity.list",
        {},
        {
          projectDirectory: projectA,
          doc: "Model",
          docId: "creation",
          docFileId: "file",
          purpose: "Inspect project A",
        },
        { requestId: "request-a" },
      ),
    );
    const jobA = await until(
      () => publicJobs(broker).find((job) => job.requestId === "request-a"),
      "owner A queued job",
    ).catch(async (error: unknown) => {
      assert(error instanceof Error);
      await first.kill();
      throw new Error(
        `${error.message}; stdout=${first.output()}; stderr=${first.diagnostics()}`,
      );
    });
    await firstCallStarted;
    assert(
      ["running", "sending"].includes(
        text(field(broker.status(), "jobs", jobA.id, "state")),
      ),
    );
    const beforePause = object(await owner.call("control-status"));
    const paused = await owner.call("pause", {
      control: {
        requestId: "mcp-context-pause",
        instanceId: beforePause["instanceId"],
        expectedGeneration: beforePause["generation"],
      },
    });
    assert.equal(
      field(paused, "phase"),
      "PAUSING",
      `pause waits for the active SDK turn; actual state: ${field(paused, "phase")}`,
    );
    await first.kill(); // The active SDK request remains; the MCP process never consumes its acknowledgement.

    const second = processClient(t, entrypoint, directory, {
      FMCAD_CLIENT: "owner-b",
      FMCAD_BACKEND: "mcp",
      FMCAD_PROJECT_DIRECTORY: projectB,
    });
    clients.push(second);
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
    );
    const savedA = snapshot.jobs[jobA.id].request;
    assert.equal(savedA.cwd, fs.realpathSync(projectA));
    assert.deepEqual(savedA.clientContext, {
      clientId: "owner-a",
      requestId: "request-a",
      sessionId: savedA.clientContext.sessionId,
      projectDirectory: fs.realpathSync(projectA),
      doc: "Model",
      docId: "creation",
      docFileId: "file",
      purpose: "Inspect project A",
    });

    const foreignResult = await second.request(
      request("foreign-result", "tools/call", {
        name: "fmcad_queue_result",
        arguments: { jobId: jobA.id },
      }),
    );
    assert(field(foreignResult, "error"));
    assert.match(text(field(foreignResult, "error", "message")), /NOT_OWNER/);
    const hiddenRequest = await second.request(
      request("foreign-request", "tools/call", {
        name: "fmcad_queue_request",
        arguments: { requestId: "request-a" },
      }),
    );
    assert.equal(
      field(hiddenRequest, "result", "structuredContent", "jobId"),
      null,
    );
    assert.equal(
      field(hiddenRequest, "result", "structuredContent", "context"),
      null,
    );

    const restarted = processClient(t, entrypoint, directory, ownerAEnv);
    clients.push(restarted);
    const recovered = await restarted.request(
      request("recover-a", "tools/call", {
        name: "fmcad_queue_request",
        arguments: { requestId: "request-a" },
      }),
    );
    const recoveredContext = field(
      recovered,
      "result",
      "structuredContent",
      "context",
    );
    assert.equal(
      field(recovered, "result", "structuredContent", "jobId"),
      jobA.id,
    );
    assert.equal(
      field(recovered, "result", "structuredContent", "status"),
      "running",
    );
    assert.equal(field(recoveredContext, "clientId"), "owner-a");
    assert.equal(
      field(recoveredContext, "projectDirectory"),
      fs.realpathSync(projectA),
    );
    assert.equal(field(recoveredContext, "docId"), "creation");
    assert.equal(field(recoveredContext, "docFileId"), "file");
    assert.equal(field(recoveredContext, "projectId"), undefined);
    assert.equal(field(recoveredContext, "purpose"), "Inspect project A");

    const duplicate = await restarted.request(
      execute(
        "duplicate-a",
        "entity.list",
        {},
        {
          projectDirectory: projectA,
          doc: "Model",
          docId: "creation",
          docFileId: "file",
          purpose: "Inspect project A",
        },
        { requestId: "request-a" },
      ),
    );
    assert.equal(
      field(duplicate, "result", "structuredContent", "jobId"),
      jobA.id,
    );
    assert.equal(
      publicJobs(broker).filter((job) => job.requestId === "request-a").length,
      1,
    );
    assert.equal(
      userCalls,
      1,
      "a duplicate request during a long SDK turn does not dispatch again",
    );

    releaseFirstCall();
    await until(
      async () =>
        field(await owner.call("control-status"), "phase") === "PAUSED",
      "pause to settle after active SDK turn",
      publicExecutionBudgetMs,
    );
    const current = object(await owner.call("control-status"));
    const resumed = await owner.call("resume", {
      control: {
        requestId: "mcp-context-resume",
        instanceId: current["instanceId"],
        expectedGeneration: current["generation"],
      },
    });
    assert(["RUNNING", "RESUMING"].includes(text(field(resumed, "phase"))));
    const aFinished = await until(
      async () => {
        const value = await restarted.request(
          request("poll-a-" + randomUUID(), "tools/call", {
            name: "fmcad_queue_request",
            arguments: { requestId: "request-a" },
          }),
        );
        return optional(value, "result", "structuredContent", "status") ===
          "succeeded"
          ? field(value, "result", "structuredContent")
          : null;
      },
      "recovered project A terminal result",
      publicExecutionBudgetMs,
    );
    const replyB = await second.request(
      execute(
        "project-b",
        "entity.list",
        {},
        {
          projectDirectory: projectB,
          doc: "Model",
          docId: "creation",
          docFileId: "file",
          projectId: "fusion-project-b",
          purpose: "Inspect project B",
        },
        { requestId: "request-b" },
      ),
    );
    const jobB = await until(
      () => publicJobs(broker).find((job) => job.requestId === "request-b"),
      "owner B project job",
    );
    assert.equal(
      optional(replyB, "result", "_meta", "fmcad", "jobId"),
      jobB.id,
      JSON.stringify(replyB),
    );
    const snapshotB = JSON.parse(
      fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
    );
    const savedB = snapshotB.jobs[jobB.id].request;
    assert.equal(savedB.cwd, fs.realpathSync(projectB));
    assert.equal(
      savedB.clientContext.projectDirectory,
      fs.realpathSync(projectB),
    );
    assert.equal(savedB.clientContext.docId, "creation");
    assert.equal(savedB.clientContext.docFileId, "file");
    assert.equal(savedB.clientContext.projectId, "fusion-project-b");
    const bFinished = await until(
      async () => {
        const value = await second.request(
          request("poll-b-" + randomUUID(), "tools/call", {
            name: "fmcad_queue_request",
            arguments: { requestId: "request-b" },
          }),
        );
        return optional(value, "result", "structuredContent", "status") ===
          "succeeded"
          ? field(value, "result", "structuredContent")
          : null;
      },
      "project B terminal result",
      publicExecutionBudgetMs,
    );
    assert.equal(
      field(aFinished, "context", "projectDirectory"),
      fs.realpathSync(projectA),
    );
    assert.equal(
      field(bFinished, "context", "projectDirectory"),
      fs.realpathSync(projectB),
    );
    const foreignReconcile = await second.request(
      request("foreign-reconcile", "tools/call", {
        name: "fmcad_queue_reconcile",
        arguments: { jobId: jobA.id },
      }),
    );
    assert(field(foreignReconcile, "error"));
    assert.match(
      text(field(foreignReconcile, "error", "message")),
      /NOT_OWNER/,
    );
    assert.equal(
      userCalls,
      2,
      "each distinct request dispatches once after resume",
    );
    await restarted.close();
    await second.close();
  },
);
