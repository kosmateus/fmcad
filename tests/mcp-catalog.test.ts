import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { createRequire } from "node:module";
import type { McpStdioDependencies } from "../src/entrypoints/mcp-stdio";
import type { JsonRpcRequest } from "../src/composition/library-mcp-protocol";
const load = createRequire(__filename),
  root = process.cwd();
const { startStdio, createCatalogPost } = load(
  path.join(root, "src/mcp-stdio"),
) as typeof import("../src/entrypoints/mcp-stdio");
const { mcpTools, catalog } = load(
  path.join(root, "src/catalog"),
) as typeof import("../src/composition/library-catalog-registry");
const { decodeCatalogInvocation } = load(
  path.join(root, "src/dist/core/catalog"),
) as typeof import("../packages/core/src/catalog");
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function field(value: unknown, ...keys: string[]): unknown {
  return keys.reduce((v, k) => object(v)[k], value);
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
function array(value: unknown): unknown[] {
  assert(Array.isArray(value));
  return value;
}

function call(name: string, args: unknown, meta?: unknown): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: "catalog-call",
    method: "tools/call",
    params: {
      name: "fmcad_cad_" + name,
      arguments: args,
      ...(meta ? { _meta: { fmcad: meta } } : {}),
    },
  };
}
async function harness(
  requests: unknown[],
  dependencies: Partial<McpStdioDependencies> = {},
): Promise<unknown[]> {
  const stdin = new PassThrough();
  let output = "";
  const running = startStdio(
    ["--routing", "queue", "--project-directory", process.cwd()],
    {
      stdin,
      stdout: new Writable({
        write(chunk: Buffer, _encoding, done) {
          output += chunk.toString();
          done();
        },
      }),
      stderr: new Writable({
        write(chunk: Buffer) {
          assert.fail(chunk.toString());
        },
      }),
      loadConfig: () => ({
        cfg: {
          routing: "queue",
          backend: "mcp",
          timeoutMs: 5000,
          headers: {},
          url: "http://host",
          tool: "execute_python",
          transport: "node",
          protocolVersion: "2025-06-18",
          queue: { autoStart: false },
          controlCenter: { port: 4748 },
        },
      }),
      QueueClient: class {
        async register() {
          assert.fail("local discovery/preflight must not register");
        }
      },
      ...dependencies,
    },
  );
  stdin.end(requests.map((value) => JSON.stringify(value)).join("\n") + "\n");
  assert(running);
  await running.closed;
  return output
    .trim()
    .split("\n")
    .map((value) => JSON.parse(value) as unknown);
}

test("stdio catalog discovery is offline and exactly projects every public operation", async () => {
  const [reply] = await harness([
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
  ]);
  assert.deepEqual(
    array(field(reply, "result", "tools")).filter((tool) =>
      text(field(tool, "name")).startsWith("fmcad_cad_"),
    ),
    mcpTools,
  );
  assert.ok(
    array(field(reply, "result", "tools")).some(
      (tool) => field(tool, "name") === "fmcad_queue_result",
    ),
  );
  assert.equal(
    array(field(reply, "result", "tools")).some(
      (tool) => field(tool, "name") === "fmcad_cad_document_save_native",
    ),
    false,
  );
  const post = createCatalogPost(
    () => assert.fail("no physical tool discovery"),
    { queued: false },
  );
  const direct = JSON.parse(
    (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).raw,
  );
  assert.deepEqual(direct.result.tools, mcpTools);
});

test("local and preview catalog calls execute shared CAD without backend/queue creation", async () => {
  const replies = await harness(
    [
      call("entity_list", {
        doc: "Model",
        data: {},
        preview: true,
        purpose: "Inspect payload",
      }),
      call("definition_inspect", {
        doc: "Model",
        data: catalog["definition.inspect"]!.example,
      }),
    ],
    {
      loadConfig: () =>
        assert.fail("local execution must not load backend config"),
    },
  );
  assert.equal(
    field(replies[0], "result", "structuredContent", "state"),
    "input-validated-only",
  );
  assert.equal(field(replies[0], "result", "isError"), false);
  assert.equal(
    field(replies[1], "result", "structuredContent", "success"),
    true,
  );
});

test("malformed envelopes and payloads fail before any admission, SDK or raw forwarding", async () => {
  const replies = await harness([
    call("entity_list", { doc: "Model", data: { unknown: 1 } }),
    call("entity_list", { doc: "Model", data: {}, preview: "true" }),
    call("entity_list", { data: {} }),
    call("entity_list", { doc: "Model", data: {}, docId: "with whitespace" }),
    call(
      "entity_list",
      { doc: "Model", data: {}, purpose: "body" },
      { description: "meta" },
    ),
    call("document_save_native", { doc: "Model", data: {} }),
    call("not_a_tool", { data: {} }),
    call("entity_list", [], {}),
    call("animation_play", {
      doc: "Model",
      data: catalog["animation.play"]!.example,
    }),
  ]);
  for (const reply of replies)
    assert.equal(field(reply, "error", "code"), -32602, JSON.stringify(reply));
  for (const value of [NaN, Infinity, undefined, () => {}]) {
    assert.throws(
      () =>
        decodeCatalogInvocation({
          version: 1,
          kind: "cad",
          operation: "entity.list",
          data: { value },
        }),
      /acyclic JSON/,
    );
  }
  assert.throws(
    () =>
      decodeCatalogInvocation({
        version: 2,
        kind: "cad",
        operation: "entity.list",
        data: {},
      }),
    /version/,
  );
});

test("SDK catalog calls submit typed payloads to the existing phased worker with purpose and pins", async () => {
  let submitted: unknown;
  const result = {
    success: true,
    operation: "entity.list",
    result: { entities: [] },
  };
  const replies = await harness(
    [
      call(
        "entity_list",
        {
          doc: "Model",
          docId: "creation",
          docFileId: "file",
          data: {},
          component: "root",
          projectId: "project",
        },
        {
          requestId: "stable-request",
          description: "Inspect part",
          sequence: { action: "continue", id: "lease" },
          expectedRevision: 4,
        },
      ),
    ],
    {
      QueueClient: class {
        async register() {}
        async submit(input: unknown) {
          submitted = input;
          return { id: "job" };
        }
        async wait() {
          return {
            job: { id: "job", state: "succeeded", revision: 5 },
            stdout: JSON.stringify(result),
          };
        }
      },
    },
  );
  assert.equal(field(submitted, "kind"), "command");
  assert.equal(field(submitted, "payload", "kind"), "cad");
  assert.equal(field(submitted, "payload", "version"), 1);
  assert.equal(field(submitted, "payload", "operation"), "entity.list");
  assert.equal(field(submitted, "payload", "docId"), "creation");
  assert.equal(field(submitted, "payload", "docFileId"), "file");
  assert.equal(field(submitted, "payload", "component"), "root");
  assert.equal(field(submitted, "payload", "projectId"), "project");
  assert.equal(field(submitted, "payload", "purpose"), "Inspect part");
  assert.equal(field(submitted, "description"), "Inspect part");
  assert.equal(field(submitted, "requestId"), "stable-request");
  assert.equal(field(submitted, "expectedRevision"), 4);
  assert.deepEqual(field(submitted, "sequence"), {
    action: "continue",
    id: "lease",
  });
  assert.deepEqual(field(submitted, "argv"), [
    "cad",
    "entity",
    "list",
    "--doc",
    "Model",
    "--doc-id",
    "creation",
    "--doc-file-id",
    "file",
  ]);
  assert.deepEqual(field(replies[0], "result", "structuredContent"), result);
  assert.equal(field(replies[0], "result", "_meta", "fmcad", "jobId"), "job");
});

test("queued catalog output reads only owned hash-bound artifacts, never advertised paths", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-artifacts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const owned = load(
    path.join(root, "src/queue-response-files"),
  ) as typeof import("../packages/node-adapters/src/persistence/owned-results");
  const job = {
    id: randomUUID(),
    state: "succeeded",
    request: { cwd: process.cwd() },
  };
  const output = {
    success: true,
    operation: "entity.list",
    result: "x".repeat(1024 * 1024 + 1),
  };
  const file = owned.responsePath(dir, job, "stdout.txt", true);
  // The fixture owns only this result directory, not the surrounding project.
  t.after(() =>
    fs.rmSync(path.dirname(file), { recursive: true, force: true }),
  );
  fs.writeFileSync(file, JSON.stringify(output));
  const descriptor = owned.describeOwnedResult(dir, job, "stdout.txt");
  let selected = { ...descriptor, path: "/definitely/not/an/authorized/path" };
  const dependencies = {
    QueueClient: class {
      readonly dir = dir;
      async register() {}
      async submit() {
        return job;
      }
      async wait() {
        return { job, outputs: { stdout: selected } };
      }
    },
  };
  const request = call(
    "entity_list",
    { doc: "Model", data: {} },
    { sequence: { action: "continue", id: "artifact-lease" } },
  );
  const [valid] = await harness([request], dependencies);
  assert.deepEqual(field(valid, "result", "structuredContent"), output);
  selected = {
    ...descriptor,
    artifact: { ...descriptor.artifact, jobId: "other-job" },
  };
  const [invalid] = await harness([request], dependencies);
  assert.equal(field(invalid, "error", "code"), -32000);
  assert.match(text(field(invalid, "error", "message")), /artifact|job|scope/i);
  fs.appendFileSync(file, "tampered");
  selected = descriptor;
  const [changed] = await harness([request], dependencies);
  assert.equal(field(changed, "error", "code"), -32000);
  assert.match(text(field(changed, "error", "message")), /hash|size/i);
});

test("direct catalog execution is denied without constructing a physical backend", async () => {
  let observed: unknown;
  const post = createCatalogPost(
    () => assert.fail("no catalog raw forwarding"),
    {
      queued: false,
      cfg: {},
      execute: async (input, client) => {
        observed = input;
        assert.equal(client, null);
        return { success: true };
      },
    },
  );
  const response = JSON.parse(
    (await post(call("entity_list", { doc: "Model", data: {} }))).raw,
  );
  assert.match(response.error.message, /requires the broker/);
  assert.equal(observed, undefined);
});

test("uncertain catalog jobs return an owned accepted receipt and are never resubmitted", async () => {
  let submits = 0,
    aborted = 0;
  const [reply] = await harness(
    [
      call(
        "entity_list",
        { doc: "Model", data: {} },
        { sequence: { action: "continue", id: "uncertain-lease" } },
      ),
    ],
    {
      QueueClient: class {
        async register() {}
        async submit() {
          submits++;
          return { id: "uncertain-job" };
        }
        wait(_id: string, { signal }: { signal: AbortSignal }) {
          return new Promise((resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => {
                aborted++;
                reject(
                  new Error("Observation stopped, not execution cancellation"),
                );
              },
              { once: true },
            ),
          );
        }
        async call(action: string, { jobId }: { jobId: string }) {
          assert.equal(action, "result");
          assert.equal(jobId, "uncertain-job");
          return {
            job: { id: jobId, state: "needs_reconciliation", revision: 9 },
          };
        }
      },
    },
  );
  assert.equal(submits, 1);
  assert.equal(aborted, 1);
  assert.equal(
    field(reply, "result", "structuredContent", "status"),
    "ACCEPTED",
  );
  assert.equal(
    field(reply, "result", "_meta", "fmcad", "jobId"),
    "uncertain-job",
  );
  assert.match(
    text(field(reply, "result", "structuredContent", "instruction")),
    /do not resubmit/,
  );
});
