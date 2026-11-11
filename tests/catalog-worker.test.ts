"use strict";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { spawn, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isolateRuntimeTestEnvironment } from "./runtime-test-environment.js";

type JsonRecord = Record<string, unknown>;
type AcceptedJob = { id: string };
type CatalogResult = { success: true; operation: string; result: JsonRecord };
type QueueJobResult = {
  job: { id: string; state: string; kind?: string; description?: string };
  stdout: string;
  stderr: string;
  execution: { mayHaveMutated: boolean };
};
type Invocation = {
  invocation: JsonRecord & { purpose: string };
  argv: string[];
};
type PhysicalRequest = {
  jsonrpc: string;
  id: string | number;
  method: string;
  params: { name: string; arguments: { object: { script: string } } };
};
type PhysicalBackend = {
  server: { timeoutMs: number };
  _parse: typeof JSON.parse;
  _post(payload: PhysicalRequest): Promise<{ status: number; raw: string }>;
  callTool(value: {
    object: { script: string };
  }): Promise<{ failed: boolean; text: string }>;
};
const localPhaseTimeoutMs = 180_000;
const projectRoot = path.resolve(__dirname, "..", "..");
const runtimeRequire = createRequire(__filename);
const { serve } = runtimeRequire(
  path.join(projectRoot, "src/queue-broker.js"),
) as {
  serve(
    config: JsonRecord,
    options: JsonRecord,
  ): Promise<{ close(): Promise<void> }>;
};
const request = runtimeRequire(
  path.join(projectRoot, "src/queue-connection.js"),
).request as <T extends object = JsonRecord>(
  directory: string,
  message: JsonRecord,
) => Promise<T>;
const { durable } = runtimeRequire(
  path.join(projectRoot, "src/queue-instance.js"),
) as {
  durable(file: string, value: unknown): void;
};
const { mcpInvocation } = runtimeRequire(
  path.join(projectRoot, "src/catalog/index.js"),
) as {
  mcpInvocation(name: string, options: JsonRecord): Invocation;
};

test("typed catalog invocation uses the real Python admission checker without importing the CLI parser", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-catalog-worker-"));
  const isolatedEnvironment = isolateRuntimeTestEnvironment(dir);
  const preload = path.join(dir, "no-worker-cli.cjs");
  fs.writeFileSync(
    preload,
    `const Module = require('node:module'); const load = Module._load;
Module._load = function(name, parent, ...rest) {
  if ((name === './cli' || name.endsWith('/cli')) && parent?.filename.includes('/src/')) throw new Error('Catalog worker must not invoke cli.main');
  return load.call(this, name, parent, ...rest);
};`,
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
  let calls = 0;
  function receipt(script: string): void {
    const binding = script.match(
      /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/,
    );
    const file = script.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
    if (!binding || !file || !binding[1] || !file[1]) return;
    const record = JSON.parse(JSON.parse(binding[1]));
    const target = JSON.parse(file[1])
      .replace(/^\\\\wsl\$\\[^\\]+/, "")
      .replaceAll("\\", "/");
    durable(target, {
      ...record,
      terminal: true,
      outcome: "succeeded",
      instance,
    });
  }
  let result: CatalogResult = {
    success: true,
    operation: "entity.list",
    result: { entities: [], observed: true },
  };
  const physical: PhysicalBackend = {
    server: { timeoutMs: 5000 },
    _parse: JSON.parse,
    async _post(payload) {
      calls++;
      receipt(payload.params.arguments.object.script);
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            content: [
              {
                type: "text",
                text: "FMCAD_RESULT " + JSON.stringify(result),
              },
            ],
          },
        }),
      };
    },
    async callTool(value) {
      const script = value.object?.script || "";
      if (script.includes("FMCAD_QUEUE_INSTANCE")) {
        receipt(script);
        return {
          failed: false,
          text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance),
        };
      }
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
  };
  const broker = await serve(
    { backend: "mcp", timeoutMs: localPhaseTimeoutMs },
    {
      dir,
      confirmOwnership: true,
      createBackend: () => physical,
      nativePath: (file: string) => file,
      pollMs: 5,
      spawnWorker(exe: string, args: string[], options: SpawnOptions) {
        return spawn(exe, args, {
          ...options,
          env: { ...options.env, NODE_OPTIONS: "--require " + preload },
        });
      },
    },
  );
  t.after(async () => {
    try {
      await broker.close();
    } finally {
      isolatedEnvironment.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const auth = {
    clientId: "catalog-worker",
    clientToken: "private-catalog-worker",
  };
  await request(dir, { action: "register", ...auth });
  const input = mcpInvocation("fmcad_cad_entity_list", {
    doc: "Model",
    docId: "creation",
    docFileId: "file",
    data: {},
    purpose: "Inspect owned part",
  });
  async function submit(
    argv: string[],
    payload: unknown = input.invocation,
  ): Promise<QueueJobResult> {
    const job = await request<AcceptedJob>(dir, {
      action: "submit",
      auth,
      request: {
        kind: "command",
        requestId: randomUUID(),
        cwd: dir,
        argv,
        ...(payload ? { payload } : {}),
        description: input.invocation.purpose,
        timeoutMs: localPhaseTimeoutMs,
      },
    });
    // PhasedWorkers has one local budget (prepare + publish); QueueState grants
    // a separate SDK budget only after readiness. A single 180s wall clock
    // incorrectly charged local preparation against that later SDK budget.
    // Keep both broker budgets and this test's 420s outer bound unchanged.
    const settlementBudgetMs = 2 * localPhaseTimeoutMs + 10_000;
    const deadline = Date.now() + settlementBudgetMs;
    let lastResult: QueueJobResult | undefined;
    while (Date.now() < deadline) {
      const value = await request<QueueJobResult>(dir, {
        action: "result",
        auth,
        jobId: job.id,
      });
      lastResult = value;
      if (
        ["succeeded", "failed", "needs_reconciliation", "expired"].includes(
          value.job.state,
        )
      )
        return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(
      `Typed catalog worker did not settle within ${settlementBudgetMs} ms (separate ${localPhaseTimeoutMs} ms local and SDK budgets); physical calls=${calls}; last result=${JSON.stringify(lastResult)}`,
    );
  }
  const completed = await submit(input.argv);
  assert.equal(completed.job.state, "succeeded", JSON.stringify(completed));
  assert.equal(completed.job.kind, "command");
  assert.equal(completed.job.description, "Inspect owned part");
  assert.deepEqual(JSON.parse(completed.stdout), result);
  assert.equal(calls, 1);
  result = {
    success: true,
    operation: "sketch.create",
    result: { source: "fake-SDK" },
  };
  const mutated = await submit(
    [
      "cad",
      "sketch",
      "create",
      "--doc",
      "Model",
      "--doc-id",
      "creation",
      "--doc-file-id",
      "file",
      "--json",
      "--data",
      JSON.stringify(
        runtimeRequire(path.join(projectRoot, "src/catalog/index.js")).catalog[
          "sketch.create"
        ].example,
      ),
    ],
    null,
  );
  assert.equal(mutated.job.state, "succeeded", JSON.stringify(mutated));
  assert.deepEqual(JSON.parse(mutated.stdout), result);
  assert.equal(mutated.execution.mayHaveMutated, true);
  assert.equal(
    calls,
    2,
    "raw legacy mutation is normalized before a no-CLI worker executes its typed service",
  );
  const rejected = await submit([
    "cad",
    "entity",
    "list",
    "--doc",
    "Different target",
  ]);
  assert.equal(rejected.job.state, "failed");
  assert.match(rejected.stderr, /differs from broker guard metadata/);
  assert.equal(
    calls,
    2,
    "mismatched guard metadata must fail before another SDK admission",
  );
});
