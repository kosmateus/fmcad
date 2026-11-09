import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import type { Client } from "../src/queue-broker-ports";
import type { BrokerModules } from "../src/queue-broker-modules";
import type { ExecutionReceipt } from "../src/api";
import { at, record, text as textValue } from "./integration/offline-cli";
const root = process.cwd(),
  load = createRequire(path.join(root, "tests/library-api-broker.test.js"));
const { createFmcad } = load("fmcad/api") as typeof import("../src/api");
const { resolveFmcadConfiguration } = load(
  path.join(root, "dist/src/dist/core"),
) as typeof import("../packages/core/src");
const { queueDirectory } = load(
  path.join(root, "dist/src/queue-connection"),
) as BrokerModules["./queue-connection"];
const { serve } = load(
  path.join(root, "dist/src/queue-broker"),
) as typeof import("../src/queue-broker");
const { brokerConfigHash, durable } = load(
  path.join(root, "dist/src/queue-instance"),
) as BrokerModules["./queue-instance"];
const { createBrokerTransport } = load(
  path.join(root, "src/dist/fusion-transport/broker"),
) as typeof import("../packages/node-adapters/src/fusion-transport/broker");
const { preparePythonArtifact, pythonArtifactManifest } = load(
  path.join(root, "src/python"),
) as typeof import("../packages/node-adapters/src/python/artifact") &
  typeof import("../packages/node-adapters/src/python/context-binding");
test("public library admits status once and rejects bad typing before the physical sender", async (t) => {
  t.after(
    (
      load(
        path.join(root, "tests/fixtures/fake-wsl-platform.cjs"),
      ) as () => () => void
    )(),
  );
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "library-broker-"));
  const oldState = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = home;
  const dir = queueDirectory();
  // The documented library default covers the real public artifact plus the
  // broker's separately checked preflight and postflight receipts. Short local
  // deadlines are asserted at the worker boundary, not in this public E2E.
  const config = {
    ...resolveFmcadConfiguration({
      adapter: { backend: "mcp", url: "http://localhost:1", timeoutMs: 180000 },
      environment: {},
      file: {},
      platformDefaults: {},
      acceptedService: null,
    }),
    queue: {
      autoStart: false,
      startupTimeoutMs: 45000,
      client: "typed-library",
    },
    controlCenter: { port: 5481 },
  };
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
  function receipt(script: string) {
    const metadata = record(
      JSON.parse(
        execFileSync(
          "python3",
          [path.join(root, "tests/fixtures/observer-python-literals.py")],
          {
            input: script,
            encoding: "utf8",
          },
        ),
      ),
    );
    const binding = metadata["_qr_binding"] || metadata["_qr_binding_value"];
    const file = metadata["_qr_path"];
    if (!binding || typeof file !== "string") return;
    const target = file.replace(/^\\\\wsl\$\\[^\\]+/, "").replaceAll("\\", "/");
    durable(target, {
      ...record(binding),
      terminal: true,
      outcome: "succeeded",
      instance,
    });
  }
  const physical = createBrokerTransport(
    {
      backend: "mcp",
      tool: "fusion_mcp_execute",
      url: "http://localhost:1",
      timeoutMs: 180000,
      headers: {},
    },
    {
      version: "test",
      requestTimeout: (server) => server.timeoutMs ?? 180000,
      bridgeSource: () => assert.fail("MCP has no bridge"),
    },
  );
  physical._post = async (payload) => {
    if (payload["method"] === "initialize")
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload["id"],
          result: { protocolVersion: at(payload, "params", "protocolVersion") },
        }),
      };
    if (payload["method"] === "notifications/initialized")
      return { status: 202, raw: "" };
    const script = textValue(
      at(payload, "params", "arguments", "object", "script"),
    );
    if (script.includes("FMCAD_QUEUE_INSTANCE")) {
      receipt(script);
      const text = "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance);
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload["id"],
          result: { content: [{ type: "text", text }] },
        }),
      };
    }
    calls++;
    receipt(script);
    const result = expected;
    const text = "FMCAD_RESULT " + JSON.stringify(result);
    return {
      status: 200,
      raw: JSON.stringify({
        jsonrpc: "2.0",
        id: payload["id"],
        result: { content: [{ type: "text", text }] },
      }),
    };
  };
  let corruptNextCall = false;
  let corruptedCalls = 0;
  const prepareCallTool = physical.prepareCallTool.bind(physical);
  physical.prepareCallTool = async (argumentsObj, toolName, origin) => {
    if (
      corruptNextCall &&
      textValue(at(argumentsObj, "object", "script")).includes("_FMCAD_REQUEST")
    ) {
      corruptNextCall = false;
      corruptedCalls++;
      if (origin) {
        const mapped = new Set(origin.sourceMap.map((entry) => entry.unitId));
        const target =
          origin.units.find((unit) => unit.role === "wrapper") ||
          origin.units.at(-1);
        assert(target);
        const artifact = preparePythonArtifact(
          origin.units.map((unit) => ({
            id: unit.id,
            filename: unit.filename,
            role: unit.role,
            source:
              unit.id === target.id
                ? unit.source + '\n_FMCAD_ADMISSION_REGRESSION: int = "bad"\n'
                : unit.source,
            embedded: !mapped.has(unit.id),
          })),
          { context: origin.context, request: origin.request },
        );
        argumentsObj = structuredClone(argumentsObj);
        record(argumentsObj["object"])["script"] = artifact.script;
        origin = pythonArtifactManifest(artifact);
      } else {
        argumentsObj = structuredClone(argumentsObj);
        record(argumentsObj["object"])["script"] =
          textValue(at(argumentsObj, "object", "script")) +
          '\n_FMCAD_ADMISSION_REGRESSION: int = "bad"\n';
      }
    }
    return prepareCallTool(argumentsObj, toolName, origin);
  };
  const owned: { broker?: Awaited<ReturnType<typeof serve>> } = {};
  const api = createFmcad({
    version: 1,
    config,
    context: {
      clientId: "public-library",
      instanceId: "library-instance",
      source: "system",
      projectDirectory: home,
    },
  });
  t.after(async () => {
    await api.dispose();
    await owned.broker?.close();
    if (oldState === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = oldState;
    fs.rmSync(home, { recursive: true, force: true });
  });
  owned.broker = await serve(config, {
    dir,
    confirmOwnership: true,
    createBackend: () => physical as unknown as Client,
    pollMs: 5,
  });
  await api.start();
  assert.equal(
    at(
      JSON.parse(fs.readFileSync(path.join(dir, "instance.json"), "utf8")),
      "configHash",
    ),
    brokerConfigHash(config),
  );
  assert.equal(at(await api.query.status(), "version"), 1);
  const accepted = await api.execute(
    {
      version: 1,
      kind: "cad",
      operation: "document.status",
      data: {},
      doc: "Model",
      docId: "creation",
      docFileId: "file",
      purpose: "Inspect owned model",
    },
    {
      requestId: "stable-library-request",
      sequence: { action: "begin", mode: "automatic" },
      queueTimeoutMs: 10000,
    },
  );
  assert(accepted.jobId);
  assert(
    accepted.sequenceId === null || typeof accepted.sequenceId === "string",
  );
  assert.equal(accepted.requestId, "stable-library-request");
  assert.equal(accepted.outcome.validation.status, "not_checked");
  assert.equal(
    at(await api.query.request("stable-library-request"), "jobId"),
    accepted.jobId,
  );
  assert.equal(await api.query.request("never-submitted"), null);
  let observed: ExecutionReceipt | undefined;
  for (let i = 0; i < 1000; i++) {
    observed = await api.query.result(accepted.jobId);
    if (
      ["succeeded", "failed", "needs_reconciliation", "expired"].includes(
        observed.state,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert(observed);
  assert.equal(observed.state, "succeeded", JSON.stringify(observed));
  assert.equal(
    typeof observed.sequenceId,
    "string",
    "sequence identity is assigned when the broker starts the job",
  );
  assert.deepEqual(observed.result, expected);
  assert.equal(
    at(observed, "output", "stdout"),
    JSON.stringify(expected, null, 0) + "\n",
  );
  assert.equal(at(observed, "output", "stderr"), "");
  assert.equal(observed.outcome.executionOutcome, "succeeded");
  assert.equal(calls, 1);
  assert(!Object.hasOwn(observed, "request"));
  assert(!Object.hasOwn(observed, "clientToken"));

  corruptNextCall = true;
  const invalid = await api.execute(
    {
      version: 1,
      kind: "cad",
      operation: "document.status",
      data: {},
      doc: "Model",
      docId: "creation",
      docFileId: "file",
      purpose: "Reject a type error before the sender",
    },
    {
      requestId: "stable-library-invalid",
    },
  );
  assert(invalid.jobId);
  let invalidObserved: ExecutionReceipt | undefined;
  for (let i = 0; i < 1000; i++) {
    invalidObserved = await api.query.result(invalid.jobId);
    if (
      ["succeeded", "failed", "needs_reconciliation", "expired"].includes(
        invalidObserved.state,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    corruptNextCall,
    false,
    "the test mutation reached the public CAD source boundary",
  );
  assert.equal(corruptedCalls, 1);
  assert(invalidObserved);
  assert.equal(
    invalidObserved.state,
    "failed",
    JSON.stringify(invalidObserved),
  );
  assert.equal(
    at(invalidObserved, "pythonChecks", 0, "status"),
    "failed",
    JSON.stringify(invalidObserved),
  );
  assert.equal(
    calls,
    1,
    "a rejected public API artifact has zero physical sender calls",
  );

  // Complete cad-v1 helper analysis is exercised by the installed-consumer
  // profile; this queue test pins the light public route and sender fences.
  assert.equal(calls, 1);
  assert(fs.existsSync(path.join(dir, "broker.lock")));
  await api.dispose();
  assert(
    fs.existsSync(path.join(dir, "broker.lock")),
    "dispose must not stop the shared broker",
  );
});
