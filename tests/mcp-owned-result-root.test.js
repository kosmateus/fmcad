"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const {
  createConsoleTelemetrySource,
} = require("../packages/node-adapters/dist/telemetry/telemetry-source");
const { startStdio } = require("../src/dist/entrypoints/mcp-stdio");
const ownedResults = require("../src/queue-response-files");
const records = require("../src/dist/node-adapters/persistence/records");

test(
  "MCP stdio root publishes the actual accepted owned result as a canonical event",
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
    assert.equal(outputs.rpc, undefined);
    assert.equal(outputs.outputs.rpc.artifact.name, "rpc-result.json");

    const events = [];
    const gaps = [];
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
      publishOwnedResult: (input) => telemetry.publishOwnedResult(input),
      async close() {
        await telemetry.close();
        telemetryClosed = true;
      },
    };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let output = "";
    let submittedRequestId;
    stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });

    class FakeQueueClient {
      constructor(id, { cfg }) {
        this.dir = queueDirectory;
        this.auth = { clientId: id };
        this.server = cfg;
      }

      async register() {}

      persistRequestContext() {}

      async submit(input) {
        assert.equal(input.payload.method, "resources/list");
        assert.equal(input.clientContext.clientId, clientId);
        submittedRequestId = input.requestId;
        return { ...baseJob, requestId: submittedRequestId };
      }

      async wait(id) {
        assert.equal(id, jobId);
        return {
          job: { ...baseJob, requestId: submittedRequestId },
          ...outputs,
        };
      }

      async close() {}
    }

    const { closed } = startStdio(
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
        stderr: { write: (text) => assert.fail(`unexpected stderr: ${text}`) },
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
    await closed;

    const response = JSON.parse(output.trim());
    assert.equal(telemetryClosed, true);
    assert.ok(response.result, JSON.stringify(response));
    assert.equal(response.id, request.id);
    assert.equal(
      response.result.resources[0].name,
      "retained response ".repeat(70_000),
    );
    assert.equal(events.length, 1);
    assert.equal(gaps.length, 0);
    const [event] = events;
    const [file] = event.outputFiles.value;
    assert.equal(event.eventType, "queue.owned-result");
    assert.ok(event.metadata.eventId.value);
    assert.equal(event.identity.jobId.value, jobId);
    assert.equal(event.identity.requestId.value, submittedRequestId);
    assert.equal(event.identity.clientId.value, clientId);
    assert.equal(event.identity.projectId.value, null);
    assert.ok(event.identity.sessionId.value);
    assert.equal(file.ownedResult.availability, "available");
    assert.deepEqual(file.ownedResult.value, outputs.outputs.rpc.artifact);
    assert.equal(file.path.value, null);
    assert.equal(file.provenance.value, "owned-mcp-response-writer");
    assert.equal(JSON.stringify(event).includes(project), false);
    await telemetry.close();
  },
);
