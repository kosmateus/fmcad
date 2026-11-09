import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import type {
  InputFrame,
  JsonRpcRequest,
  OwnedMcpArtifactReference,
} from "../src/entrypoints/mcp-framing";
import type { ConsoleTelemetryEvent, ConsoleTelemetryGap } from "@fmcad/core";
const load = createRequire(__filename),
  repo = process.cwd();
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function field(value: unknown, ...keys: string[]): unknown {
  return keys.reduce((v, k) => object(v)[k], value);
}
function array(value: unknown): unknown[] {
  assert(Array.isArray(value));
  return value;
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
function owned(value: unknown): OwnedMcpArtifactReference {
  const v = object(value);
  assert.equal(v["version"], 1);
  assert.equal(v["name"], "rpc-result.json");
  assert(v["storage"] === "legacy" || v["storage"] === "project");
  assert.equal(typeof v["bytes"], "number");
  text(v["jobId"]);
  text(v["scope"]);
  text(v["sha256"]);
  // Preserve the exact decoded object, including any unexpected fields, for
  // the production owned-result boundary to validate.
  return value as OwnedMcpArtifactReference;
}
const {
  JsonLineDecoder,
  MCP_MAX_INPUT_FRAME_BYTES,
  MCP_MAX_PENDING_REQUESTS,
  MCP_MAX_SIZE_DIAGNOSTICS,
  MCP_MAX_STDOUT_FRAME_BYTES,
  boundedDiagnosticLine,
  parseJsonRpcRequest,
  parseMcpResponseMessages,
  serializeMcpFrame,
} = load(
  path.join(repo, "src/dist/entrypoints/mcp-framing"),
) as typeof import("../src/entrypoints/mcp-framing");
const {
  McpFrameWriter,
  createMcpStdioTransport,
  createOwnedMcpResponseWriter,
  createStdioFrameHandler,
  queueHelperRequest,
} = load(
  path.join(repo, "src/dist/entrypoints/mcp-stdio-transport"),
) as typeof import("../src/entrypoints/mcp-stdio-transport");
const { createConsoleTelemetrySource } = load(
  path.join(repo, "packages/node-adapters/dist/telemetry/telemetry-source"),
) as typeof import("../packages/node-adapters/src/telemetry/telemetry-source");

function artifactReference(
  bytes: Uint8Array,
  jobId = "framing_test",
): OwnedMcpArtifactReference {
  return {
    version: 1,
    jobId,
    name: "rpc-result.json",
    scope: "a".repeat(64),
    storage: "legacy",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

class SlowWritable extends EventEmitter {
  writes: Buffer[] = [];
  activeWrites = 0;
  maxActiveWrites = 0;
  closed = false;

  write(frame: string | Uint8Array) {
    if (this.closed) {
      const error = Object.assign(new Error("pipe closed"), { code: "EPIPE" });
      throw error;
    }
    this.writes.push(Buffer.from(frame));
    this.activeWrites++;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    setTimeout(() => {
      this.activeWrites--;
      this.emit("drain");
    }, 2);
    return false;
  }

  destroy() {
    this.closed = true;
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}

function parseFrames(writable: SlowWritable): unknown[] {
  return writable.writes.map(
    (frame) => JSON.parse(frame.toString("utf8")) as unknown,
  );
}

test("UTF-8 JSONL decoder counts bytes across chunks, reports invalid UTF-8 and recovers after an oversized frame", async () => {
  const decoder = new JsonLineDecoder(12);
  const frames: InputFrame[] = [];
  const consume = (frame: InputFrame) => {
    frames.push(frame);
  };
  const bytes = Buffer.from('{"x":"é"}\n', "utf8");
  assert.ok(bytes.length > '{"x":"é"}\n'.length);
  await decoder.push(bytes.subarray(0, 7), consume);
  await decoder.push(bytes.subarray(7), consume);
  await decoder.push(Buffer.from('{"too":"long"}\n{"id":1}\n'), consume);
  await decoder.push(Buffer.from([0xff, 0x0a]), consume);
  assert.deepEqual(frames, [
    { kind: "line", text: '{"x":"é"}' },
    { kind: "too-large" },
    { kind: "line", text: '{"id":1}' },
    { kind: "invalid-utf8" },
  ]);
  assert.equal(decoder.bufferedBytes, 0);
  assert.equal(MCP_MAX_INPUT_FRAME_BYTES, 1024 * 1024);
});

test("JSON-RPC request and upstream JSON/SSE framing reject invalid ids and retain images exactly", () => {
  const invalid = parseJsonRpcRequest(
    '{"jsonrpc":"2.0","id":false,"method":"ping"}',
  );
  assert("error" in invalid);
  assert.equal(field(invalid.error, "error", "code"), -32600);
  const valid = parseJsonRpcRequest('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  assert("request" in valid);
  assert.equal(valid.request.id, 1);
  const image = { type: "image", mimeType: "image/png", data: "AAECAw==" };
  const response = {
    jsonrpc: "2.0" as const,
    id: "img",
    result: { content: [image] },
  };
  assert.deepEqual(parseMcpResponseMessages(JSON.stringify(response)), [
    response,
  ]);
  assert.deepEqual(
    parseMcpResponseMessages(
      `event: message\r\ndata: ${JSON.stringify(response)}\r\n\r\n`,
    ),
    [response],
  );
  assert.deepEqual(
    parseMcpResponseMessages(`data: ${JSON.stringify(response)}\n\n`),
    [response],
  );
  assert.throws(
    () => parseMcpResponseMessages('{"jsonrpc":"2.0","id":{},"result":{}}'),
    /id/,
  );
  assert.throws(
    () => parseMcpResponseMessages('{"jsonrpc":"2.0","result":{}}'),
    /missing its id/,
  );
});

test("slow stdout reader gets one write at a time and input admission stays within the pending limit", async () => {
  const input = new PassThrough();
  const output = new SlowWritable();
  let active = 0;
  let maxActive = 0;
  let maxPendingRequests = 0;
  let maxPendingOutputFrames = 0;
  const transport = createMcpStdioTransport({
    input,
    output,
    pendingLimit: 2,
    isConcurrent: () => true,
    handle: async (frame) => {
      assert.equal(frame.kind, "line");
      assert(frame.kind === "line");
      active++;
      maxActive = Math.max(maxActive, active);
      maxPendingRequests = Math.max(
        maxPendingRequests,
        transport.pendingRequests,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      const request = JSON.parse(frame.text);
      const output = transport.writer.send(
        { jsonrpc: "2.0" as const, id: request.id, result: {} },
        {
          request,
          response: {
            status: 200,
            raw: JSON.stringify({
              jsonrpc: "2.0" as const,
              id: request.id,
              result: {},
            }),
          },
        },
      );
      maxPendingOutputFrames = Math.max(
        maxPendingOutputFrames,
        transport.writer.pendingSends,
      );
      await output;
      active--;
    },
  });
  input.end(
    Array.from({ length: 24 }, (_, id) =>
      JSON.stringify({ jsonrpc: "2.0" as const, id, method: "ping" }),
    ).join("\n") + "\n",
  );
  await transport.closed;
  assert.equal(maxActive, 2);
  assert.equal(maxPendingRequests, 2);
  assert.equal(maxPendingRequests <= MCP_MAX_PENDING_REQUESTS, true);
  assert.ok(maxPendingOutputFrames <= 2);
  assert.equal(
    output.maxActiveWrites,
    1,
    "a write returning false must drain before another frame is written",
  );
  assert.deepEqual(
    parseFrames(output).map((message) => field(message, "id")),
    Array.from({ length: 24 }, (_, id) => id),
  );
});

test("undefined write return from a minimal stdout adapter does not wait for a nonexistent drain", async () => {
  const output = new EventEmitter() as EventEmitter & {
    write(frame: string | Uint8Array): unknown;
    destroy(): EventEmitter;
  };
  const writes: Buffer[] = [];
  output.write = (frame) => writes.push(Buffer.from(frame));
  const writer = new McpFrameWriter(output);
  const request: JsonRpcRequest = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "ping",
  };
  await writer.send(
    { jsonrpc: "2.0" as const, id: 1, result: {} },
    { request },
  );
  assert.equal(writes.length, 1);
});

test("internal limit overrides cannot raise the fixed stdio resource ceilings", () => {
  assert.throws(
    () =>
      new McpFrameWriter(new SlowWritable(), {
        maxFrameBytes: MCP_MAX_STDOUT_FRAME_BYTES + 1,
      }),
    /fixed MCP stdout limit/,
  );
  assert.throws(
    () =>
      createMcpStdioTransport({
        input: new PassThrough(),
        output: new SlowWritable(),
        pendingLimit: MCP_MAX_PENDING_REQUESTS + 1,
        handle: async () => undefined,
      }),
    /fixed MCP request limit/,
  );
  assert.throws(
    () =>
      createMcpStdioTransport({
        input: new PassThrough(),
        output: new SlowWritable(),
        maxInputFrameBytes: MCP_MAX_INPUT_FRAME_BYTES + 1,
        handle: async () => undefined,
      }),
    /fixed MCP input limit/,
  );
});

test("EOF waits for accepted handlers to settle before closing transport", async () => {
  const input = new PassThrough();
  const output = new SlowWritable();
  let release: (() => void) | undefined;
  let calls = 0;
  const transport = createMcpStdioTransport({
    input,
    output,
    handle: async () => {
      calls++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  input.end('{"jsonrpc":"2.0","id":"accepted","method":"tools/call"}');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  let closed = false;
  transport.closed.then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert(release);
  release();
  await transport.closed;
  assert.equal(closed, true);
});

test("EPIPE stops further input but leaves an accepted post alone and waits for it", async () => {
  const input = new PassThrough();
  const output = new EventEmitter() as EventEmitter & {
    write(frame: string | Uint8Array): unknown;
    destroy(): EventEmitter;
  };
  let writes = 0;
  output.write = () => {
    writes++;
    const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    queueMicrotask(() => output.emit("error", error));
    return false;
  };
  output.destroy = () => {
    queueMicrotask(() => output.emit("close"));
    return output;
  };
  let release: (() => void) | undefined;
  let posts = 0;
  const transport = createMcpStdioTransport({
    input,
    output,
    isConcurrent: () => true,
    handle: async () => {
      posts++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await transport.writer.send(
        { jsonrpc: "2.0" as const, id: 1, result: {} },
        { request: { jsonrpc: "2.0" as const, id: 1, method: "tools/call" } },
      );
    },
  });
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call"}\n');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(posts, 1);
  assert(release);
  release();
  await transport.closed;
  assert.equal(posts, 1, "the accepted call is not resubmitted after EPIPE");
  assert.equal(writes, 1);
});

test("forwarder preserves session/version, queue helpers and queue receipt metadata without another initialize", async () => {
  const output = new SlowWritable();
  const writer = new McpFrameWriter(output);
  const queueTool = {
    name: "fmcad_queue_status",
    inputSchema: { type: "object" },
  };
  const calls: {
    method: string;
    session: string | undefined;
    version: string | undefined;
  }[] = [];
  const post = async (
    request: JsonRpcRequest,
    session?: string,
    version?: string,
  ) => {
    calls.push({ method: request.method, session, version });
    if (request.method === "initialize") {
      return {
        status: 200,
        sessionId: "one-session",
        raw: JSON.stringify({
          jsonrpc: "2.0" as const,
          id: request.id,
          result: { protocolVersion: "2025-11-25" },
        }),
      };
    }
    if (request.method === "tools/list") {
      return {
        status: 200,
        queueTools: true,
        raw: JSON.stringify({
          jsonrpc: "2.0" as const,
          id: request.id,
          result: { tools: [queueTool, { name: "another" }] },
        }),
      };
    }
    return {
      status: 200,
      queueReceipt: { jobId: "queue-1", state: "succeeded" },
      raw: JSON.stringify({
        jsonrpc: "2.0" as const,
        id: request.id,
        result: {
          content: [{ type: "text", text: "ok" }],
          structuredContent: { status: "pass" },
        },
      }),
    };
  };
  const forward = createStdioFrameHandler(writer, post, {
    queueTools: [queueTool],
  });
  await forward({
    kind: "line",
    text: JSON.stringify({
      jsonrpc: "2.0" as const,
      id: 1,
      method: "initialize",
    }),
  });
  await forward({
    kind: "line",
    text: JSON.stringify({
      jsonrpc: "2.0" as const,
      method: "notifications/initialized",
    }),
  });
  await forward({
    kind: "line",
    text: JSON.stringify({
      jsonrpc: "2.0" as const,
      id: 2,
      method: "tools/list",
    }),
  });
  await forward({
    kind: "line",
    text: JSON.stringify({
      jsonrpc: "2.0" as const,
      id: 3,
      method: "tools/call",
      params: { name: "fmcad_queue_status", arguments: {} },
    }),
  });
  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.slice(1).map((call) => [call.session, call.version]),
    [
      ["one-session", "2025-11-25"],
      ["one-session", "2025-11-25"],
      ["one-session", "2025-11-25"],
    ],
  );
  const messages = parseFrames(output);
  assert.equal(messages.length, 3, "notifications never generate a response");
  assert.deepEqual(
    array(field(messages[1], "result", "tools")).map((tool) =>
      field(tool, "name"),
    ),
    ["another", "fmcad_queue_status"],
  );
  assert.deepEqual(field(messages[2], "result", "_meta", "fmcad"), {
    jobId: "queue-1",
    state: "succeeded",
  });
});

test("bad upstream ids fail closed locally and neither replay nor expose upstream content", async () => {
  const output = new SlowWritable();
  const writer = new McpFrameWriter(output);
  let calls = 0;
  const forward = createStdioFrameHandler(
    writer,
    async () => {
      calls++;
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0" as const,
          id: "wrong-id",
          result: { secret: "UPSTREAM_SECRET" },
        }),
      };
    },
    {},
  );
  await forward({
    kind: "line",
    text: '{"jsonrpc":"2.0","id":"expected","method":"tools/call"}',
  });
  assert.equal(calls, 1);
  const response = parseFrames(output)[0];
  assert.equal(field(response, "id"), "expected");
  assert.equal(field(response, "error", "code"), -32000);
  assert.doesNotMatch(JSON.stringify(response), /wrong-id|UPSTREAM_SECRET/);
});

test("duplicate upstream response IDs fail before either frame reaches stdout", async () => {
  const output = new SlowWritable();
  const writer = new McpFrameWriter(output);
  const response = (id: string | number, value: string) =>
    `data: ${JSON.stringify({ jsonrpc: "2.0" as const, id, result: { value } })}\n\n`;
  const forward = createStdioFrameHandler(
    writer,
    async () => ({
      status: 200,
      raw: response("duplicate", "first") + response("duplicate", "second"),
    }),
    {},
  );
  await forward({
    kind: "line",
    text: '{"jsonrpc":"2.0","id":"duplicate","method":"ping"}',
  });
  const messages = parseFrames(output);
  assert.equal(messages.length, 1);
  assert.equal(field(messages[0], "error", "code"), -32000);
  assert.doesNotMatch(JSON.stringify(messages), /first|second/);
});

test("large content plus structuredContent is externalized whole with status and without becoming an SDK error", async () => {
  const output = new SlowWritable();
  const reported: unknown[] = [];
  const writer = new McpFrameWriter(output, {
    maxFrameBytes: MCP_MAX_STDOUT_FRAME_BYTES,
    onOwnedResult: (...event) => reported.push(event),
  });
  const value = "full-result-π-".repeat(400_000);
  const rpc = {
    jsonrpc: "2.0" as const,
    id: "large",
    result: {
      content: [{ type: "text", text: value }],
      structuredContent: { status: "complete", payload: value },
      isError: false,
    },
  };
  const raw = JSON.stringify(rpc);
  const request: JsonRpcRequest = {
    jsonrpc: "2.0" as const,
    id: "large",
    method: "tools/call",
    params: { name: "fmcad_execute" },
  };
  const responseArtifact = artifactReference(
    Buffer.from(JSON.stringify({ status: 201, raw })),
  );
  await writer.send(rpc, {
    request,
    response: { status: 201, raw, ownedArtifact: responseArtifact },
  });
  const outputMessage = parseFrames(output)[0];
  assert.ok(
    Buffer.byteLength(JSON.stringify(rpc) + "\n") > MCP_MAX_STDOUT_FRAME_BYTES,
  );
  assert.ok(output.writes[0]!.length < MCP_MAX_STDOUT_FRAME_BYTES);
  assert.equal(field(outputMessage, "id"), "large");
  assert.equal(
    field(outputMessage, "result", "structuredContent", "status"),
    "EXTERNALIZED",
  );
  assert.equal(
    field(outputMessage, "result", "structuredContent", "complete"),
    true,
  );
  assert.equal(
    field(outputMessage, "result", "structuredContent", "originalHttpStatus"),
    201,
  );
  assert.equal(
    field(outputMessage, "result", "structuredContent", "resultStatus"),
    "complete",
  );
  assert.equal(field(outputMessage, "result", "isError"), false);
  assert.deepEqual(
    field(outputMessage, "result", "structuredContent", "artifact"),
    responseArtifact,
  );
  assert.deepEqual(reported, []);
});

test("in-limit owned MCP responses publish only pathless producer identity", async () => {
  const output = new SlowWritable();
  const message = {
    jsonrpc: "2.0" as const,
    id: "small-owned",
    result: { content: [{ type: "text", text: "complete" }] },
  };
  const reference = artifactReference(Buffer.from("stored response"));
  const reported: unknown[] = [];
  const writer = new McpFrameWriter(output, {
    onOwnedResult: (input) => reported.push(input),
  });
  const request: JsonRpcRequest = {
    jsonrpc: "2.0" as const,
    id: "small-owned",
    method: "tools/call",
    params: { name: "fmcad_execute" },
  };
  const response = {
    status: 200,
    raw: JSON.stringify(message),
    artifactOwner: { jobId: reference.jobId, cwd: "/private/project" },
    queueReceipt: {
      jobId: reference.jobId,
      state: "succeeded",
      revision: 7,
      requestId: "queue-request",
      context: {
        clientId: "mcp-client",
        projectId: "project-id",
        sessionId: "session-id",
        turnId: "turn-id",
        docId: "document-id",
        docFileId: "document-file-id",
        purpose: "inspect",
        projectDirectory: "/private/project",
      },
    },
    ownedArtifact: reference,
  };
  await writer.send(message, { request, response });

  assert.deepEqual(parseFrames(output), [message]);
  assert.deepEqual(reported, [
    {
      job: {
        id: reference.jobId,
        requestId: "queue-request",
        clientId: "mcp-client",
        projectId: "project-id",
        turnId: "turn-id",
        sessionId: "session-id",
        documentId: "document-id",
        documentFileId: "document-file-id",
        purpose: "inspect",
        state: "succeeded",
        transport: "mcp-stdio",
        agentId: null,
        agent: null,
        model: null,
        role: null,
        physicalTurns: null,
        physicalTurnOrdinal: null,
        revision: 7,
      },
      reference,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(reported),
    /private\/project|projectDirectory|cwd/,
  );

  const outputAfterReporterError = new SlowWritable();
  const throwingWriter = new McpFrameWriter(outputAfterReporterError, {
    onOwnedResult() {
      throw new Error("telemetry sink unavailable");
    },
  });
  await throwingWriter.send(message, {
    request,
    response,
  });
  assert.deepEqual(parseFrames(outputAfterReporterError), [message]);
});

test("large MCP responses use the existing owned result store and remain fully readable by reference", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-mcp-owned-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".cad"));
  const directory = path.join(root, "queue");
  fs.mkdirSync(directory);
  const store = load(
    path.join(repo, "src/queue-response-files"),
  ) as typeof import("../packages/node-adapters/src/persistence/owned-results");
  const records = load(
    path.join(repo, "src/dist/node-adapters/persistence/records"),
  ) as typeof import("../packages/node-adapters/src/persistence/records");
  const job = { id: "stored_job", request: { cwd: root } };
  const fullRaw = JSON.stringify({
    status: 200,
    raw: JSON.stringify({
      jsonrpc: "2.0" as const,
      id: "stored",
      result: {
        content: [{ type: "text", text: "persist all data ".repeat(200) }],
        structuredContent: { status: "complete" },
      },
    }),
  });
  records.durable(
    store.responsePath(directory, job, "rpc-result.json", true),
    JSON.parse(fullRaw),
  );
  const reference = store.describeOwnedResult(
    directory,
    job,
    "rpc-result.json",
  ).artifact;
  const output = new SlowWritable();
  const writer = new McpFrameWriter(output, { maxFrameBytes: 1024 });
  const stored = JSON.parse(fullRaw);
  const raw = stored.raw;
  const request: JsonRpcRequest = {
    jsonrpc: "2.0" as const,
    id: "stored",
    method: "tools/call",
    params: { name: "fmcad_execute" },
  };
  await writer.send(JSON.parse(raw), {
    request,
    response: { status: 200, raw, ownedArtifact: reference },
  });
  const pointer = owned(
    field(parseFrames(output)[0], "result", "structuredContent", "artifact"),
  );
  const { readOwnedResult } = load(
    path.join(repo, "src/queue-response-files"),
  ) as typeof import("../packages/node-adapters/src/persistence/owned-results");
  const bytes = readOwnedResult(
    directory,
    { jobId: pointer.jobId, cwd: root },
    pointer,
  );
  assert.equal(pointer.storage, "project");
  assert.equal(pointer.jobId, job.id);
  assert.equal(JSON.parse(bytes.toString("utf8")).status, 200);
  assert.equal(JSON.parse(bytes.toString("utf8")).raw, raw);
  assert.equal(bytes.length, pointer.bytes);
});

test("local oversized responses are atomically published in the existing owned-result store", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-mcp-publish-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".cad"));
  const directory = path.join(root, "queue");
  const store = load(
    path.join(repo, "src/queue-response-files"),
  ) as typeof import("../packages/node-adapters/src/persistence/owned-results");
  const durable = load(
    path.join(repo, "src/dist/node-adapters/persistence/records"),
  ) as typeof import("../packages/node-adapters/src/persistence/records");
  const output = new SlowWritable();
  const reported: unknown[] = [];
  const writer = new McpFrameWriter(output, {
    maxFrameBytes: 1024,
    onOwnedResult: (...event) => reported.push(event),
    externalize: createOwnedMcpResponseWriter({
      directory,
      store,
      durable,
      resolveProject: () => root,
    }),
  });
  const raw = JSON.stringify({
    jsonrpc: "2.0" as const,
    id: 4,
    result: {
      content: [{ type: "text", text: "complete-local-result ".repeat(100) }],
    },
  });
  const request: JsonRpcRequest = {
    jsonrpc: "2.0" as const,
    id: 4,
    method: "tools/call",
    params: { name: "fmcad_help" },
  };
  await writer.send(JSON.parse(raw), {
    request,
    response: { status: 200, raw },
  });
  const pointer = owned(
    field(parseFrames(output)[0], "result", "structuredContent", "artifact"),
  );
  assert.deepEqual(reported, []);
  const { readOwnedResult } = store;
  const bytes = readOwnedResult(
    directory,
    { jobId: pointer.jobId, cwd: root },
    pointer,
  );
  const artifact = JSON.parse(bytes.toString("utf8"));
  assert.match(pointer.jobId, /^[a-f0-9-]{36}$/);
  assert.equal(artifact.status, 200);
  assert.equal(artifact.raw, raw);
});

test("queued oversized responses keep the accepted job as the artifact owner", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-mcp-queue-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".cad"));
  const directory = path.join(root, "queue");
  const store = load(
    path.join(repo, "src/queue-response-files"),
  ) as typeof import("../packages/node-adapters/src/persistence/owned-results");
  const durable = load(
    path.join(repo, "src/dist/node-adapters/persistence/records"),
  ) as typeof import("../packages/node-adapters/src/persistence/records");
  const output = new SlowWritable();
  const jobId = "accepted_job";
  const events: ConsoleTelemetryEvent[] = [];
  const gaps: ConsoleTelemetryGap[] = [];
  const telemetry = createConsoleTelemetrySource({
    sourceId: "mcp-stdio-owned-result-test",
    epoch: "mcp-process-test-epoch",
    now: () => 1000,
    sink: {
      async append(event) {
        events.push(event);
      },
    },
    onGap(gap) {
      gaps.push(gap);
    },
  });
  const writer = new McpFrameWriter(output, {
    maxFrameBytes: 1024,
    externalize: createOwnedMcpResponseWriter({
      directory,
      store,
      durable,
      onOwnedResult: (input) => telemetry.publishOwnedResult(input),
      resolveProject: () => root,
    }),
  });
  const raw = JSON.stringify({
    jsonrpc: "2.0" as const,
    id: 5,
    result: { content: [{ type: "text", text: "queued result ".repeat(100) }] },
  });
  const request: JsonRpcRequest = {
    jsonrpc: "2.0" as const,
    id: 5,
    method: "tools/call",
    params: { name: "fmcad_execute" },
  };
  await writer.send(JSON.parse(raw), {
    request,
    response: {
      status: 200,
      raw,
      queueReceipt: {
        jobId,
        state: "succeeded",
        revision: 3,
        requestId: "accepted-request",
        context: {
          clientId: "mcp-client",
          projectId: "project-id",
          sessionId: "session-id",
          purpose: "execute",
        },
      },
      artifactOwner: { jobId, cwd: root },
    },
  });
  const reference = owned(
    field(parseFrames(output)[0], "result", "structuredContent", "artifact"),
  );
  assert.equal(reference.jobId, jobId);
  const artifact = JSON.parse(
    store
      .readOwnedResult(directory, { jobId, cwd: root }, reference)
      .toString("utf8"),
  );
  assert.equal(artifact.status, 200);
  assert.equal(artifact.raw, raw);
  await telemetry.flush();
  assert.equal(events.length, 1);
  assert.equal(gaps.length, 0);
  const event = events[0];
  assert(event);
  assert(event.outputFiles.value?.[0]?.ownedResult);
  const outputFile = event.outputFiles.value[0];
  assert(outputFile);
  assert(outputFile.ownedResult);
  assert.equal(event.eventType, "queue.owned-result");
  assert.ok(event.metadata.eventId.value);
  assert.equal(event.identity.jobId.value, jobId);
  assert.equal(event.identity.requestId.value, "accepted-request");
  assert.equal(event.identity.clientId.value, "mcp-client");
  assert.equal(event.identity.projectId.value, "project-id");
  assert.equal(event.outputFiles.value?.length, 1);
  assert.deepEqual(outputFile.ownedResult.value, reference);
  assert.equal(outputFile.path.value, null);
  assert.equal(outputFile.provenance.value, "owned-mcp-response-writer");
  await telemetry.close();
});

test("near-limit frames stay exact and over-10-MiB catalogs use a complete owned artifact", async (t) => {
  const nearOutput = new SlowWritable();
  const nearWriter = new McpFrameWriter(nearOutput);
  const fixed = {
    jsonrpc: "2.0" as const,
    id: 1,
    result: { content: [{ type: "text", text: "" }] },
  };
  const overhead = Buffer.byteLength(JSON.stringify(fixed) + "\n");
  const near = {
    ...fixed,
    result: {
      content: [
        {
          type: "text",
          text: "n".repeat(MCP_MAX_STDOUT_FRAME_BYTES - overhead - 128),
        },
      ],
    },
  };
  const nearFrame = serializeMcpFrame(near);
  assert.ok(nearFrame.length < MCP_MAX_STDOUT_FRAME_BYTES);
  await nearWriter.send(near, {
    request: { jsonrpc: "2.0" as const, id: 1, method: "tools/list" },
    response: { status: 200, raw: JSON.stringify(near) },
  });
  assert.deepEqual(nearOutput.writes[0], nearFrame);

  const bigOutput = new SlowWritable();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-mcp-big-list-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "queue");
  const store = load(
    path.join(repo, "src/queue-response-files"),
  ) as typeof import("../packages/node-adapters/src/persistence/owned-results");
  const durable = load(
    path.join(repo, "src/dist/node-adapters/persistence/records"),
  ) as typeof import("../packages/node-adapters/src/persistence/records");
  const bigWriter = new McpFrameWriter(bigOutput, {
    externalize: createOwnedMcpResponseWriter({
      directory,
      store,
      durable,
      resolveProject: () => null,
    }),
  });
  const bigText = "z".repeat(10 * 1024 * 1024 + 128);
  const large = {
    jsonrpc: "2.0" as const,
    id: 2,
    result: { content: [{ type: "text", text: bigText }] },
  };
  const raw = JSON.stringify(large);
  assert.ok(Buffer.byteLength(JSON.stringify(large) + "\n") > 10 * 1024 * 1024);
  const diagnostics: unknown[] = [];
  const forward = createStdioFrameHandler(
    bigWriter,
    async (request) => {
      const responseRaw = JSON.stringify({ ...large, id: request.id });
      return { status: 200, raw: responseRaw };
    },
    {
      backend: "mcp",
      routing: "queue",
      clientInstanceId: "7adbd668-39e9-4a9a-9f4d-62cf81a247b2",
      log: (record) => diagnostics.push(record),
    },
  );
  await forward({
    kind: "line",
    text: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
  });
  const response = parseFrames(bigOutput)[0];
  assert.ok(bigOutput.writes[0]!.length < MCP_MAX_STDOUT_FRAME_BYTES);
  assert.deepEqual(field(response, "result", "tools"), []);
  assert.equal(
    field(response, "result", "_meta", "fmcad", "status"),
    "EXTERNALIZED",
  );
  assert.equal(
    field(response, "result", "_meta", "fmcad", "listComplete"),
    false,
  );
  const reference = owned(
    field(response, "result", "_meta", "fmcad", "artifact"),
  );
  const artifact = JSON.parse(
    store
      .readOwnedResult(directory, { jobId: reference.jobId }, reference)
      .toString("utf8"),
  );
  assert.equal(artifact.status, 200);
  assert.equal(artifact.raw, raw);
  assert.ok(artifact.raw.includes(bigText));
  assert.equal(reference.storage, "legacy");
  assert.equal(fs.existsSync(path.join(root, ".cad")), false);
  assert.doesNotMatch(JSON.stringify(response), /zzzzzz/);
  const sizeRecord = diagnostics.find(
    (record) => field(record, "event") === "mcp_response_size",
  );
  assert.ok(sizeRecord);
  assert.equal(field(sizeRecord, "method"), "tools/list");
  assert.ok(
    Number(field(sizeRecord, "stdoutFrameBytes")) > MCP_MAX_STDOUT_FRAME_BYTES,
  );
  assert.equal(field(sizeRecord, "routing"), "queue");
  const safeLine = boundedDiagnosticLine(object(sizeRecord));
  assert.ok(Buffer.byteLength(safeLine) < 2048);
  assert.doesNotMatch(safeLine, /zzzzzz|bigText|raw|content/);
});

test("queue-helper and image-heavy results preserve their artifact and queue metadata", async () => {
  const queueRequest = JSON.stringify({
    jsonrpc: "2.0" as const,
    id: "helper",
    method: "tools/call",
    params: { name: "fmcad_queue_result", arguments: { jobId: "job-1" } },
  });
  assert.equal(queueHelperRequest(queueRequest), true);
  assert.equal(
    queueHelperRequest(
      queueRequest.replace("fmcad_queue_result", "fmcad_queue_begin"),
    ),
    false,
  );

  const output = new SlowWritable();
  const writer = new McpFrameWriter(output, { maxFrameBytes: 2048 });
  const base64 = Buffer.from("image-data-".repeat(600)).toString("base64");
  const original = {
    jsonrpc: "2.0" as const,
    id: "helper",
    result: {
      content: [{ type: "image", mimeType: "image/png", data: base64 }],
      structuredContent: { status: "complete", image: base64 },
      isError: false,
      _meta: { fmcad: { jobId: "job-1", state: "succeeded" } },
    },
  };
  const imageRequest: JsonRpcRequest = {
    jsonrpc: "2.0" as const,
    id: "image",
    method: "tools/call",
    params: { name: "capture_viewport", arguments: {} },
  };
  const imageMessage = {
    ...original,
    id: "image",
    result: {
      ...original.result,
      _meta: { fmcad: { jobId: "image_job", state: "succeeded" } },
    },
  };
  const imageRaw = JSON.stringify(imageMessage);
  const imageArtifact = artifactReference(
    Buffer.from(JSON.stringify({ status: 200, raw: imageRaw })),
    "image_job",
  );
  await writer.send(imageMessage, {
    request: imageRequest,
    response: {
      status: 200,
      raw: imageRaw,
      queueReceipt: { jobId: "image_job", state: "succeeded" },
      ownedArtifact: imageArtifact,
    },
  });
  const pointer = parseFrames(output)[0];
  assert.ok(Buffer.byteLength(JSON.stringify(imageMessage) + "\n") > 2048);
  assert.equal(
    field(pointer, "result", "structuredContent", "queueReceipt", "jobId"),
    "image_job",
  );
  assert.equal(field(pointer, "result", "isError"), false);
  assert.deepEqual(
    field(pointer, "result", "structuredContent", "artifact"),
    imageArtifact,
  );
  assert.ok(imageRaw.includes(base64));
});

test("stderr metadata is whitelisted, redacted and bounded", () => {
  const record = boundedDiagnosticLine({
    event: "mcp_response_size",
    clientInstanceId: "7adbd668-39e9-4a9a-9f4d-62cf81a247b2",
    requestIdHash: "b".repeat(24),
    method: "tools/call",
    toolName: "fmcad_execute",
    stdoutFrameBytes: 10 * 1024 * 1024,
    thresholdBytes: MCP_MAX_STDOUT_FRAME_BYTES,
    code: "TOKEN_SECRET",
    secret: "TOKEN_SECRET",
    rawResponse: "RESPONSE_SECRET",
  });
  assert.ok(Buffer.byteLength(record) < 2048);
  assert.doesNotMatch(
    record,
    /TOKEN_SECRET|RESPONSE_SECRET|secret|rawResponse/,
  );
  assert.equal(JSON.parse(record).stdoutFrameBytes, 10 * 1024 * 1024);
});

test("transport stderr diagnostics have a per-process cap and omit handler messages", async () => {
  const input = new PassThrough();
  const output = new SlowWritable();
  const diagnostics: unknown[] = [];
  const transport = createMcpStdioTransport({
    input,
    output,
    handle: async () => {
      throw new Error("PRIVATE_RESPONSE_AND_TOKEN_SECRET");
    },
    onDiagnostic: (line) => diagnostics.push(line),
  });
  input.end(
    Array.from({ length: 30 }, (_, id) =>
      JSON.stringify({ jsonrpc: "2.0" as const, id, method: "ping" }),
    ).join("\n") + "\n",
  );
  await transport.closed;
  assert.equal(diagnostics.length, MCP_MAX_SIZE_DIAGNOSTICS);
  assert.ok(diagnostics.every((line) => Buffer.byteLength(text(line)) < 2048));
  assert.doesNotMatch(diagnostics.join("\n"), /PRIVATE_RESPONSE|TOKEN_SECRET/);
});

test("connection loss is not an initialize/replay signal", async () => {
  const output = new SlowWritable();
  const writer = new McpFrameWriter(output);
  let postCount = 0;
  const forward = createStdioFrameHandler(
    writer,
    async () => {
      postCount++;
      throw Object.assign(new Error("unknown outcome"), { code: "ETIMEDOUT" });
    },
    {},
  );
  await forward({
    kind: "line",
    text: '{"jsonrpc":"2.0","id":"once","method":"tools/call"}',
  });
  assert.equal(postCount, 1);
  assert.equal(field(parseFrames(output)[0], "id"), "once");
  assert.equal(field(parseFrames(output)[0], "error", "data", "retry"), false);
  assert.equal(postCount, 1);
});

test("reconnect starts with local adapter state and never sends an implicit initialize", async () => {
  const calls: {
    method: string;
    session: string | undefined;
    version: string | undefined;
  }[] = [];
  const post = async (
    request: JsonRpcRequest,
    session?: string,
    version?: string,
  ) => {
    calls.push({ method: request.method, session, version });
    return {
      status: 200,
      ...(request.method === "initialize" ? { sessionId: "session-one" } : {}),
      raw: JSON.stringify({
        jsonrpc: "2.0" as const,
        id: request.id,
        result:
          request.method === "initialize"
            ? { protocolVersion: "2025-11-25" }
            : {},
      }),
    };
  };
  const first = createStdioFrameHandler(
    new McpFrameWriter(new SlowWritable()),
    post,
    {},
  );
  const second = createStdioFrameHandler(
    new McpFrameWriter(new SlowWritable()),
    post,
    {},
  );
  await first({
    kind: "line",
    text: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
  });
  await first({
    kind: "line",
    text: '{"jsonrpc":"2.0","id":2,"method":"ping"}',
  });
  await second({
    kind: "line",
    text: '{"jsonrpc":"2.0","id":3,"method":"ping"}',
  });
  assert.deepEqual(calls, [
    { method: "initialize", session: undefined, version: undefined },
    { method: "ping", session: "session-one", version: "2025-11-25" },
    { method: "ping", session: undefined, version: undefined },
  ]);
});
