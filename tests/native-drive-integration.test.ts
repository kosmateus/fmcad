import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";
import type {
  NativeRequest,
  ModelingFixtureCli,
  ModelingFixtureMcp,
  ModelingFixtureStdio,
  ModelingFixtureReceipt,
  ModelingFixtureServices,
} from "./modeling-unit-test-support";
const load = createRequire(
  path.join(process.cwd(), "tests/native-drive-integration.test.ts"),
);
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function field(value: unknown, ...keys: string[]): unknown {
  return keys.reduce((current, key) => record(current)[key], value);
}
const { pythonLiteral } = load(
  "../packages/node-adapters/dist/python/artifact",
) as typeof import("../packages/node-adapters/src/python/artifact");

const operation = "mechanism.drive-test";
const request = {
  schemaVersion: 1,
  confirm: true,
  driver: { kind: "joint", name: "Driver" },
  waypoints: [0.02, 0.04, 0.06],
  followers: [
    {
      joint: { kind: "joint", name: "Follower" },
      coordinate: "rotation",
      ratio: -2,
      phase: 0.3,
      tolerance: 0.000001,
    },
  ],
};

test("catalog, typed CLI and MCP share the driver-test contract", async (t) => {
  const {
    catalog,
    contracts,
    cliContracts,
    mcpTools,
    mcpInvocation,
    validateInvocation,
  } = load(
    "../src/catalog",
  ) as typeof import("../src/composition/library-catalog-registry");
  const { commands } = load(
    "../src/commands",
  ) as typeof import("../src/composition/library-commands");
  const { detail } = load(
    "../src/help",
  ) as typeof import("../src/composition/library-help");
  const descriptor = catalog[operation];
  assert.ok(descriptor);
  assert.equal(descriptor.readOnly, false);
  assert.equal(descriptor["envelope"], true);
  assert.deepEqual(descriptor.required, [
    "schemaVersion",
    "confirm",
    "driver",
    "waypoints",
    "followers",
  ]);
  assert.equal(contracts[operation]!.service.kind, "python");
  assert.equal(contracts[operation]!.service.handler, operation);
  assert.equal(contracts[operation]!.readOnlyRequested, false);
  assert.equal(cliContracts([])[operation]!.cli.key, "mechanism drive-test");
  assert.ok(commands.some((command) => command.target === operation));
  assert.ok(contracts["mechanism.couple"]);
  assert.ok(contracts["mechanism.inspect"]);
  assert.ok(contracts["mechanism.stop-check"]);

  const invocation = {
    version: 1,
    kind: "cad",
    operation,
    doc: "Synthetic",
    docId: "native-drive-document",
    data: request,
  };
  assert.deepEqual(validateInvocation(invocation), invocation);
  const mcpTool = mcpTools.find(
    (tool) => tool._meta.fmcad.operation === operation,
  );
  assert.ok(mcpTool);
  assert.equal(mcpTool.name, "fmcad_cad_mechanism_drive_test");
  assert.ok(mcpTool.inputSchema.required.includes("data"));
  const projected = mcpInvocation(mcpTool.name, {
    doc: "Synthetic",
    docId: "native-drive-document",
    data: request,
  });
  assert.equal(projected.operation, operation);
  assert.deepEqual(projected.invocation.data, request);

  for (const data of [
    { ...request, confirm: false },
    { ...request, waypoints: [0, 2] },
    { ...request, followers: [] },
    {
      ...request,
      followers: [{ ...request.followers[0], ratio: 0 }],
    },
    {
      ...request,
      followers: [{ ...request.followers[0], coordinate: "linear" }],
    },
    { ...request, extra: true },
  ]) {
    assert.throws(
      () => validateInvocation({ ...invocation, data }),
      /confirm:true|increments|followers|ratio|coordinate|Unknown CAD inputs/,
    );
  }
  const help = detail("mechanism", "drive-test");
  assert.match(help, /nativeCapability\.status remains unknown/);
  assert.match(help, /one driver restore/);
  assert.match(
    help,
    /--preview also checks the bounded driver\/follower shape/,
  );
  assert.match(help, /coordinated broker runtime/);

  const { main: cliMain } = load("../src/cli") as ModelingFixtureCli;
  const { executeInvocation } = load(
    "../src/catalog/execute",
  ) as typeof import("../src/composition/catalog-execution");
  const { prepareCadScript } = load(
    "../src/cad",
  ) as typeof import("../src/composition/cad");
  const { createMcpApplication } = load(
    "../src/dist/entrypoints/mcp",
  ) as ModelingFixtureMcp;
  const expected = {
    schemaVersion: 1,
    operation,
    status: "pass",
    passed: true,
    outcome: "complete",
    nativeCapability: {
      status: "unknown",
      motionLinkCreation: "separate-operation-not-run",
      qualified: false,
      evidence: "fake broker response is not native qualification",
    },
    actualSolver: { status: "pass", samples: [] },
    restore: {
      status: "pass",
      readback: { joints: {}, transforms: {} },
      errors: [],
    },
  };
  const calls: { operation?: string; script: string; sha256?: string }[] = [];
  const broker = {
    async callTool(call: NativeRequest & { featureType: string }) {
      assert.equal(call.featureType, "script");
      assert.equal(call.object.readOnly, false);
      assert.match(
        call.object.script,
        /CAD_HANDLERS\.update\(\{[\s\S]*?'mechanism\.drive-test': mechanism_drive_test,[\s\S]*?'mechanism\.motion-link\.create': mechanism_motion_link_create[\s\S]*?\}\)/,
      );
      assert.match(call.object.script, /mechanism\.drive-test/);
      assert.match(call.object.script, /_FMCAD_REQUEST: "_FMCADRequest" = \{/);
      assert.ok(
        call.object.script.includes(`"operation": ${pythonLiteral(operation)}`),
      );
      assert.ok(
        call.object.script.includes(`"data": ${pythonLiteral(request)}`),
        "broker receives the owned prepared request artifact",
      );
      calls.push({
        script: call.object.script,
        sha256: crypto
          .createHash("sha256")
          .update(call.object.script)
          .digest("hex"),
      });
      return {
        failed: false,
        text: "FMCAD_RESULT " + JSON.stringify(expected),
      };
    },
  };

  const preview = await executeInvocation(
    { ...invocation, preview: true },
    null,
  );
  assert.equal(field(preview, "state"), "input-validated-only");
  assert.equal(field(preview, "mutation"), false);
  assert.match(
    String((field(preview, "limitations") as unknown[])[0]),
    /no entity resolution, native reads, motion, restore/,
  );
  assert.equal(calls.length, 0);

  const prepared = prepareCadScript(operation, request, {
    doc: "Synthetic",
    docId: "native-drive-document",
  });
  assert.ok(prepared.units.some((unit) => unit.id === "native-drive-handlers"));
  assert.equal(
    prepared.sha256,
    crypto.createHash("sha256").update(prepared.script).digest("hex"),
  );
  const direct = await executeInvocation(invocation, broker);
  assert.equal(field(direct, "operation"), operation);
  assert.equal(field(direct, "nativeCapability", "status"), "unknown");
  assert.equal(calls[0]!.script, prepared.script);
  assert.equal(calls[0]!.sha256, prepared.sha256);

  const previous = process.cwd();
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-native-drive-cli-"),
  );
  process.chdir(temporary);
  t.after(() => {
    process.chdir(previous);
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  let stdout = "";
  let stderr = "";
  const service = (): ModelingFixtureServices => {
    let lastReceipt: ModelingFixtureReceipt | undefined;
    return {
      async start() {},
      async execute(payload, options) {
        const routed =
          payload.kind === "cad-command" ? payload.invocation : payload;
        const result = await executeInvocation(routed, broker);
        lastReceipt = {
          version: 1,
          requestId: options.requestId,
          jobId: "native-drive-job",
          state: "succeeded",
          result,
          outcome: {
            acceptance: "accepted",
            executionOutcome: "succeeded",
            validation: { status: "not_checked" },
          },
        };
        return lastReceipt;
      },
      query: {
        async result(jobId) {
          assert.equal(jobId, lastReceipt?.jobId);
          return lastReceipt;
        },
      },
      async dispose() {},
    };
  };
  const code = await cliMain(
    [
      "mechanism",
      "drive-test",
      "--doc",
      "Synthetic",
      "--doc-id",
      "native-drive-document",
      "--data",
      JSON.stringify(request),
      "--json",
    ],
    {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      loadConfig: () => ({
        cfg: { routing: "queue", backend: "mcp", timeoutMs: 5000, headers: {} },
      }),
      createFmcad: service,
      setExitCode() {},
    },
  );
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).operation, operation);
  assert.match(stderr, /^FMCAD_QUEUE_REQUEST /);

  const application = createMcpApplication({
    queueTools: [],
    compatibility() {
      assert.fail("driver-test must use typed catalog dispatch");
    },
    services: () => service(),
  });
  const mcpResponse = await application({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: mcpTool.name,
      arguments: {
        doc: "Synthetic",
        docId: "native-drive-document",
        data: request,
      },
      _meta: { fmcad: { requestId: "native-drive-mcp" } },
    },
  });
  assert.ok(mcpResponse.artifactOwner, JSON.stringify(mcpResponse));
  assert.equal(mcpResponse.artifactOwner.jobId, "native-drive-job");
  assert.equal(field(mcpResponse.queueReceipt, "jobId"), "native-drive-job");
  const response = JSON.parse(mcpResponse.raw);
  assert.equal(response.result.structuredContent.operation, operation);
  assert.equal(
    response.result.structuredContent.nativeCapability.status,
    "unknown",
  );
  assert.equal(calls.length, 3);
});

test("oversized native-drive MCP result is externalized under the accepted job owner", async (t) => {
  const project = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-drive-owned-project-"),
  );
  const state = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-drive-owned-state-"),
  );
  fs.mkdirSync(path.join(project, ".cad"));
  const previousState = process.env["XDG_STATE_HOME"];
  process.env["XDG_STATE_HOME"] = state;
  t.after(() => {
    if (previousState === undefined) delete process.env["XDG_STATE_HOME"];
    else process.env["XDG_STATE_HOME"] = previousState;
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  });

  const joints = Object.fromEntries(
    Array.from({ length: 33 }, (_, index) => [
      index === 0 ? "driver" : "follower:" + (index - 1),
      { rotation: index / 1000, slide: index / 1000 },
    ]),
  );
  const transforms = Object.fromEntries(
    Array.from({ length: 66 }, (_, occurrence) => [
      String(occurrence),
      Object.fromEntries(
        Array.from({ length: 16 }, (_, value) => [
          String(value),
          1234567890123.125 + occurrence + value,
        ]),
      ),
    ]),
  );
  const pose = { joints, transforms };
  const samples = Array.from({ length: 240 }, (_, index) => ({
    index,
    actual: pose,
    unwrappedPhase: Object.fromEntries(
      Object.entries(joints).map(([key, value]) => [key, value.rotation]),
    ),
    driverResidual: 0,
    followerResiduals: Array(32).fill(0),
    passed: true,
  }));
  const result = {
    schemaVersion: 1,
    operation,
    status: "pass",
    passed: true,
    outcome: "complete",
    commandedMathTrack: Array.from({ length: 240 }, (_, index) => ({
      index,
      driver: index / 1000,
      followers: Array(32).fill(index / 2000),
    })),
    actualSolver: { status: "pass", samples },
    nativeCapability: {
      status: "unknown",
      motionLinkCreation: "separate-operation-not-run",
      qualified: false,
      evidence: "oversized synthetic result does not qualify native capability",
    },
    capture: pose,
    restore: { status: "pass", readback: pose, errors: [] },
    errors: [],
    units: { rotation: "rad", slide: "cm", transformTranslation: "cm" },
    limitations: [
      "Synthetic payload tests the owned-response size boundary only.",
    ],
  };

  const stdin = new PassThrough();
  let stdout = "";
  const { startStdio } = load("../src/mcp-stdio") as ModelingFixtureStdio;
  const { closed } = startStdio(
    ["--routing", "queue", "--backend", "mcp", "--project-directory", project],
    {
      stdin,
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => assert.fail(text) },
      loadConfig: () => ({
        cfg: { routing: "queue", backend: "mcp", timeoutMs: 5000, headers: {} },
      }),
      createFmcad: () => {
        let lastReceipt: ModelingFixtureReceipt | undefined;
        return {
          async start() {},
          async execute(input, options) {
            assert.equal(input.operation, operation);
            lastReceipt = {
              version: 1,
              requestId: options.requestId,
              jobId: "native-drive-owned-job",
              state: "succeeded",
              result,
              outcome: {
                acceptance: "accepted",
                executionOutcome: "succeeded",
                validation: { status: "not_checked" },
              },
            };
            return lastReceipt;
          },
          query: {
            async result(jobId) {
              assert.equal(jobId, lastReceipt?.jobId);
              return lastReceipt;
            },
          },
          async dispose() {},
        };
      },
    },
  );
  stdin.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "native-drive-large-result",
      method: "tools/call",
      params: {
        name: "fmcad_cad_mechanism_drive_test",
        arguments: { doc: "Synthetic", data: request },
        _meta: { fmcad: { requestId: "native-drive-large-request" } },
      },
    }) + "\n",
  );
  await closed;

  const response = JSON.parse(stdout.trim());
  assert.ok(response.result?.structuredContent, stdout);
  const pointer = response.result.structuredContent.artifact;
  assert.equal(response.result.structuredContent.status, "EXTERNALIZED");
  assert.equal(response.result.structuredContent.resultStatus, "pass");
  assert.equal(pointer.jobId, "native-drive-owned-job");
  assert.equal(pointer.storage, "project");
  assert.ok(pointer.bytes > 8 * 1024 * 1024);
  const store = load(
    "../src/queue-response-files",
  ) as typeof import("../packages/node-adapters/src/persistence/owned-results");
  const queueDirectory = (
    load("../src/queue-connection") as { queueDirectory(): string }
  ).queueDirectory();
  const bytes = store.readOwnedResult(
    queueDirectory,
    { jobId: pointer.jobId, cwd: project },
    pointer,
  );
  const stored = JSON.parse(bytes.toString("utf8"));
  const fullResponse = JSON.parse(stored.raw);
  assert.equal(fullResponse.result.structuredContent.operation, operation);
  assert.equal(
    fullResponse.result.structuredContent.actualSolver.samples.length,
    240,
  );
  assert.equal(
    fullResponse.result.structuredContent.nativeCapability.status,
    "unknown",
  );
});
