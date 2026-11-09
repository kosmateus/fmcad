import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createRequire } from "node:module";
import type { FmcadConfiguration } from "../src/api";
import type { ConsoleTelemetryEvent, ConsoleTelemetryGap } from "@fmcad/core";
const load = createRequire(__filename),
  repo = process.cwd();
const { createConsoleTelemetrySource } = load(
  path.join(repo, "src/dist/node-adapters/telemetry/telemetry-source"),
) as typeof import("../packages/node-adapters/src/telemetry/telemetry-source");
const { startStdio } = load(
  path.join(repo, "src/dist/entrypoints/mcp-stdio"),
) as typeof import("../src/entrypoints/mcp-stdio");
const ownedResults = load(
  path.join(repo, "src/queue-response-files"),
) as typeof import("../packages/node-adapters/src/persistence/owned-results");
const records = load(
  path.join(repo, "src/dist/node-adapters/persistence/records"),
) as typeof import("../packages/node-adapters/src/persistence/records");
function object(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function field(value: unknown, ...names: string[]): unknown {
  return names.reduce((value, name) => object(value)[name], value);
}

test(
  "MCP stdio root publishes the actual accepted owned result as a canonical event",
  { timeout: 20000 },
  async (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "fmcad-mcp-owned-root-"),
    );
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const project = path.join(root, "project");
    fs.mkdirSync(path.join(project, ".cad"), { recursive: true });
    const queueDirectory = path.join(root, "queue");
    fs.mkdirSync(queueDirectory, { recursive: true });

    const jobId = "accepted_owned_job";
    const clientId = "mcp_owned_client";
    const raw = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      result: {
        resources: [
          {
            uri: "file:///retained-resource",
            name: "retained response ".repeat(70_000),
          },
        ],
      },
    });
    const baseJob = {
      id: jobId,
      state: "succeeded",
      revision: 3,
      clientId,
      request: { cwd: project },
    };
    const responsePath = ownedResults.responsePath(
      queueDirectory,
      baseJob,
      "rpc-result.json",
      true,
    );
    records.durable(responsePath, { status: 200, raw });
    const outputs = ownedResults.jobOutputs(queueDirectory, baseJob);
    assert.equal(outputs["rpc"], undefined);
    assert.equal(
      field(outputs, "outputs", "rpc", "artifact", "name"),
      "rpc-result.json",
    );

    const events: ConsoleTelemetryEvent[] = [];
    const gaps: ConsoleTelemetryGap[] = [];
    const telemetry = createConsoleTelemetrySource({
      sourceId: "mcp-stdio-root-owned-result",
      epoch: "mcp-stdio-root-epoch",
      now: () => 1234,
      maxPendingEvents: 8,
      sink: {
        async append(event) {
          events.push(event);
        },
      },
      onGap(gap) {
        gaps.push(gap);
      },
    });
    let telemetryClosed = false;
    const ownedResultTelemetry = {
      publishOwnedResult: (
        input: Parameters<typeof telemetry.publishOwnedResult>[0],
      ) => telemetry.publishOwnedResult(input),
      async close() {
        await telemetry.close();
        telemetryClosed = true;
      },
    };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let output = "";
    let submittedRequestId: unknown;
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    class FakeQueueClient {
      readonly dir: string;
      readonly auth: { clientId: string };
      readonly server: FmcadConfiguration;
      constructor(id: string, { cfg }: { cfg: FmcadConfiguration }) {
        this.dir = queueDirectory;
        this.auth = { clientId: id };
        this.server = cfg;
      }

      async register() {}

      persistRequestContext() {}

      async submit(input: unknown) {
        assert.equal(field(input, "payload", "method"), "resources/list");
        assert.equal(field(input, "clientContext", "clientId"), clientId);
        submittedRequestId = field(input, "requestId");
        return { ...baseJob, requestId: submittedRequestId };
      }

      async wait(id: string) {
        assert.equal(id, jobId);
        return {
          job: { ...baseJob, requestId: submittedRequestId },
          ...outputs,
        };
      }

      async close() {}
    }

    const running = startStdio(
      [
        "--backend",
        "mcp",
        "--routing",
        "queue",
        "--project-directory",
        project,
        "--client",
        clientId,
      ],
      {
        stdin,
        stdout,
        stderr: new Writable({
          write(text: Buffer) {
            assert.fail(`unexpected stderr: ${text.toString()}`);
          },
        }),
        loadConfig: () => ({
          cfg: {
            backend: "mcp",
            routing: "queue",
            url: "http://127.0.0.1:47123/mcp",
            headers: {},
            timeoutMs: 5000,
            tool: "execute_python",
            transport: "node",
            protocolVersion: "2025-06-18",
            queue: { autoStart: false },
            controlCenter: { port: 4748 },
          },
        }),
        QueueClient: FakeQueueClient,
        createTelemetry: () => ownedResultTelemetry,
      },
    );
    const request = {
      jsonrpc: "2.0",
      id: 7,
      method: "resources/list",
    };
    stdin.end(JSON.stringify(request) + "\n");
    assert(running);
    await running.closed;

    const response: unknown = JSON.parse(output.trim());
    assert.equal(telemetryClosed, true);
    assert.ok(field(response, "result"), JSON.stringify(response));
    assert.equal(field(response, "id"), request.id);
    assert.equal(
      field((field(response, "result", "resources") as unknown[])[0], "name"),
      "retained response ".repeat(70_000),
    );
    assert.equal(events.length, 1);
    assert.equal(gaps.length, 0);
    const [event] = events;
    assert(event);
    assert(event.outputFiles.value);
    const [file] = event.outputFiles.value;
    assert(file);
    assert.equal(event.eventType, "queue.owned-result");
    assert.ok(event.metadata.eventId.value);
    assert.equal(event.identity.jobId.value, jobId);
    assert.equal(event.identity.requestId.value, submittedRequestId);
    assert.equal(event.identity.clientId.value, clientId);
    assert.equal(event.identity.projectId.value, null);
    assert.ok(event.identity.sessionId.value);
    assert(file.ownedResult);
    assert.equal(file.ownedResult.availability, "available");
    assert.deepEqual(
      file.ownedResult.value,
      field(outputs, "outputs", "rpc", "artifact"),
    );
    assert.equal(file.path.value, null);
    assert.equal(file.provenance.value, "owned-mcp-response-writer");
    assert.equal(JSON.stringify(event).includes(project), false);
    await telemetry.close();
  },
);
