import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import type { AuditScope } from "../packages/node-adapters/src/execution/recovery-audit";
interface StoredIntent {
  binding: { epochId: string; sdkProofPath: string };
}
interface StoredStart {
  receipt: string;
  binding: Record<string, unknown>;
}
interface Result {
  status: string;
  sdkRequestsSent: number;
  activation: { admission: string };
}
type ProductionControl =
  typeof import("../src/composition/queue-epoch-successor-control").createSuccessorControl;
// The retained synthetic fixture deliberately omits unused production ports.
// Preserve that boundary rather than supplying callbacks it never had.
type FixtureControlPorts = Omit<
  Parameters<ProductionControl>[0],
  "closed" | "epochFence" | "epochSnapshot" | "ports"
> & {
  ports: Omit<Parameters<ProductionControl>[0]["ports"], "jobDirectory">;
};

import type { DeadEpochFixture } from "./fixtures/epoch-fixture-types";
import type { PythonArtifactManifest } from "../packages/core/src/domain/python-artifact";
const repository = process.cwd();
const load = createRequire(
  path.join(repository, "tests", "dead-epoch-successor-control.test.js"),
);

const api = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const canonicalHash = (value: unknown) =>
  (
    load(
      "../src/dist/core/application/cad/json",
    ) as typeof import("../packages/core/src/application/cad/json")
  ).hash(value);
const { openIsolatedEpoch } = load(
  "../src/queue-isolated-epoch",
) as typeof import("../src/queue-isolated-epoch");
const { createSuccessorControl } = load(
  "../src/queue-epoch-successor-control",
) as {
  createSuccessorControl(
    ports: FixtureControlPorts,
  ): ReturnType<ProductionControl>;
};

test("full broker MCP callsites use the real pinned production checker before synthetic observe/create/close", () => {
  const root = fs.mkdtempSync("/tmp/opencode/successor-mcp-production-");
  try {
    const output = spawnSync(
      process.execPath,
      [
        path.join(repository, "tests/fixtures/successor-mcp-production.cjs"),
        root,
      ],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 180000,
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    assert.equal(output.status, 0, output.stderr || String(output.error));
    const marker = output.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("FULL_MCP_PRODUCTION_CHECKER_RESULT "));
    assert.ok(marker, output.stdout);
    const result = JSON.parse(
      marker.slice("FULL_MCP_PRODUCTION_CHECKER_RESULT ".length),
    ) as {
      passed: boolean;
      realSdkRequests: number;
      syntheticToolCalls: number;
    };
    assert.equal(result.passed, true);
    assert.equal(result.realSdkRequests, 0);
    assert.equal(result.syntheticToolCalls, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("full broker refuses a changed selected process before constructing the physical MCP client", () => {
  const root = fs.mkdtempSync("/tmp/opencode/successor-mcp-process-refusal-");
  try {
    const output = spawnSync(
      process.execPath,
      [
        path.join(repository, "tests/fixtures/successor-mcp-production.cjs"),
        root,
        "process-refusal",
      ],
      {
        cwd: repository,
        encoding: "utf8",
        timeout: 30000,
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      },
    );
    assert.equal(output.status, 0, output.stderr || String(output.error));
    assert.match(
      output.stdout,
      /FULL_MCP_PROCESS_REFUSAL .*"factories":0,"requests":0/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ["server-error", "missing-receipt", "wrong-receipt"])
  test(
    "native MCP full broker preserves " +
      mode +
      " response without settlement or replay",
    () => {
      const root = fs.mkdtempSync("/tmp/opencode/native-mcp-response-");
      try {
        const output = spawnSync(
          process.execPath,
          [
            path.join(
              repository,
              "tests/fixtures/successor-mcp-production.cjs",
            ),
            root,
            mode,
          ],
          {
            cwd: repository,
            encoding: "utf8",
            timeout: 90000,
            env: { ...process.env, NODE_TEST_CONTEXT: undefined },
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        assert.equal(output.status, 0, output.stderr || String(output.error));
        assert.match(
          output.stdout,
          /FULL_MCP_RESPONSE_FAILURE .*"preserved":true,"sdkRequestsSent":1,"nativeOutcome":"unknown","realSdkRequests":0/,
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

const { BrokerMcpClient } = load(
  "../src/dist/fusion-transport/mcp",
) as typeof import("../packages/node-adapters/src/fusion-transport/mcp");
type ScriptClient = InstanceType<typeof BrokerMcpClient> & {
  executeBrokerScript(
    script: string,
    origin: PythonArtifactManifest,
    readOnly?: boolean,
  ): Promise<unknown>;
};

function mcpClient(post: AuditScope["post"]) {
  const client = new BrokerMcpClient(
    { url: "http://127.0.0.1:1/never-used", backend: "mcp", timeoutMs: 1000 },
    {
      version: "offline-fixture",
      requestTimeout: () => 1000,
      bridgeSource: () => "",
    },
  ) as ScriptClient;
  let discoveryPosts = 0;
  // Only the physical adapter is fake. Session admission, manifest binding,
  // prepared calls and tool framing remain the real BrokerMcpClient methods.
  client._post = async (payload, sessionId) => {
    if (payload["method"] === "initialize") {
      discoveryPosts++;
      return {
        status: 200,
        sessionId: "offline-session",
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload["id"],
          result: { protocolVersion: "2024-11-05" },
        }),
      };
    }
    if (payload["method"] === "notifications/initialized") {
      discoveryPosts++;
      return { status: 202, raw: "" };
    }
    const method = payload["method"];
    assert.equal(typeof method, "string");
    return (await post({ ...payload, method: String(method) }, sessionId)) as {
      status: number;
      raw: string;
    };
  };
  return { client, discoveryPosts: () => discoveryPosts };
}

function fixture(t: TestContext, mode = "success", transport = "synthetic") {
  t.after((load("./fixtures/fake-wsl-platform.cjs") as () => () => void)());
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "successor-control-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const f = (
    load("./fixtures/dead-epoch-successor.cjs") as (
      base: string,
      root: string,
      options?: { oldProcessAlive?: boolean; inFlight?: boolean },
    ) => DeadEpochFixture
  )(base, repository, { inFlight: true });
  fs.rmSync(path.join(f.audit, "isolated-scratch-qualification"), {
    recursive: true,
    force: true,
  }); // Prospective synthetic proof only.
  const state = openIsolatedEpoch(f.dir, { recover: false });
  let sdk = 0,
    physicalActive = 0,
    busy = false,
    activations = 0;
  const identity = {
    ...f.authority.expectedProcess,
    version: "fixture",
    activeCommand: "SelectCommand",
  };
  const message = (suffix: string) => ({
    jobId: f.pointer.quarantinedJobIds[0]!,
    observationJobId: f.pointer.quarantinedJobIds[1]!,
    requestId: f.requestId + suffix,
    control: { fixture: true },
  });
  const sendScript = (scope: AuditScope, script: string, readOnly = true) => {
    if (transport !== "synthetic") {
      const { client } = mcpClient(scope.post);
      return transport === "legacy-mcp"
        ? client.callTool(
            { featureType: "script", object: { script, readOnly: true } },
            "fusion_mcp_execute",
            scope.origin,
          )
        : client.executeBrokerScript(script, scope.origin, readOnly);
    }
    return scope.post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "execute_python",
          arguments: { code: scope.expectedCode, persistent: false },
        },
      },
      "synthetic-session",
    );
  };
  const control = createSuccessorControl({
    dir: f.dir,
    state,
    configHash: api.brokerConfigHash(f.cfg),
    buildHash: f.authority.buildHash,
    clients: () => ({ [f.clientId]: api.hash(f.token) }),
    authority: f.authorityEntry,
    assertControl(value) {
      assert.deepEqual(value, { fixture: true });
    },
    fenceRuntime(inFlight) {
      assert.equal(physicalActive, inFlight ? 1 : 0);
    },
    sendAuditScript: (scope, script) => sendScript(scope, script, true),
    sendScratchScript: (scope, script) => sendScript(scope, script, false),
    activate() {
      activations++;
    },
    ports: {
      ...(transport === "mcp" ? { scriptFormat: "fusion-mcp" as const } : {}),
      installation: repository,
      buildHash: f.authority.buildHash,
      begin() {
        assert.equal(busy, false);
        busy = true;
      },
      end() {
        busy = false;
      },
      admit: async (send) => {
        physicalActive++;
        try {
          return await send();
        } finally {
          physicalActive--;
        }
      },
      check: async () => ({ report: { status: "passed" }, fence() {} }), // FAKE checker; no production/live qualification claim.
      match: (response) =>
        JSON.parse(response["raw"] as string) as Record<string, unknown>,
      async post(payload) {
        sdk++;
        const creating = fs.existsSync(
          path.join(f.audit, "isolated-scratch-qualification", "start.json"),
        );
        const dir = path.join(
          f.audit,
          creating
            ? "isolated-scratch-qualification"
            : "dead-epoch-current-observation",
        );
        const prior = api.readJson(
            path.join(dir, "intent.json"),
          ) as StoredIntent,
          start = api.readJson(path.join(dir, "start.json")) as StoredStart;
        if (
          (!creating && mode === "lost-observation") ||
          (creating && mode === "lost-creation")
        )
          throw Object.assign(new Error("Synthetic transport uncertainty"), {
            code: "SYNTHETIC_LOST_REPLY",
          });
        const summary = creating
          ? {
              version: 1,
              purpose: "isolated-scratch-epoch-v1",
              epochId: prior.binding.epochId,
              bindingHash: canonicalHash(prior.binding),
              document: {
                name: "FMCAD_ISOLATED_" + prior.binding.epochId,
                creationId: "really-new-synthetic-sdk-id",
                fileId: null,
              },
              independent: true,
              empty: true,
              unsaved: true,
              activeCommand: "SelectCommand",
              beforeIdsHash: "c".repeat(64),
              historicalOutcome: "unknown",
              originalModelValidation: "not_performed",
              originalRollbackVerification: "not_performed",
              previousActiveCreationId: "synthetic-user-active-document",
            }
          : {
              version: 1,
              purpose: "atomic-recovery-audit-v1",
              profile: "atomic-recovery-counts-v1",
              requestIdentity: f.auditIdentity,
              nativeOutcome: "unknown",
              modelValidation: "not_performed",
              rollbackVerification: "not_performed",
              modulePresent: false,
              ui: { activeCommand: "SelectCommand", idle: true },
              commandDefinition: { status: "absent" },
              document: { status: "absent", matches: 0 },
              snapshot: null,
              fingerprint: null,
            };
        if (!creating && mode === "unsafe-ui")
          summary.ui = { activeCommand: "SketchLine", idle: false };
        if (!creating && mode === "surviving-holder")
          summary.modulePresent = true;
        if (creating) api.durable(prior.binding.sdkProofPath, summary, true);
        api.durable(
          start.receipt,
          {
            ...start.binding,
            terminal: true,
            outcome: "succeeded",
            instance: identity,
          },
          true,
        );
        return {
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              content: [
                {
                  type: "text",
                  text: "FMCAD_RESULT " + JSON.stringify(summary),
                },
              ],
            },
          }),
        };
      },
    },
  });
  return {
    ...f,
    state,
    control,
    message,
    sdk: () => sdk,
    busy: () => busy,
    activations: () => activations,
  };
}

test("legacy Python guard refuses official payload without the explicit native script format", async (t) => {
  const f = fixture(t, "success", "legacy-mcp");
  const observed = await settled(f, "observe", f.message(":observe"));
  assert.equal(observed.status, "failed");
  assert.equal(observed.sdkRequestsSent, 0);
  const result = api.readJson(
    path.join(f.audit, "dead-epoch-current-observation/result.json"),
  ) as { code: string };
  assert.equal(result.code, "AUDIT_REQUEST_INVALID");
  assert.equal(f.sdk(), 0);
});

test("real MCP client: fixed audit and scratch creation keep original manifests and exact code", async (t) => {
  const f = fixture(t, "success", "mcp");
  await assert.rejects(f.control.observe(f.message(":observe"), "foreign"), {
    code: "NOT_OWNER",
  });
  assert.equal(f.sdk(), 0);
  const observed = await settled(f, "observe", f.message(":observe"));
  assert.equal(observed.status, "complete", JSON.stringify(observed));
  const created = await settled(f, "create", f.message(":create"));
  assert.equal(created.status, "complete", JSON.stringify(created));
  assert.equal(f.sdk(), 2);
  await settled(f, "observe", f.message(":observe"));
  await settled(f, "create", f.message(":create"));
  assert.equal(
    f.sdk(),
    2,
    "Reading original receipts must not replay fixed scripts",
  );
});

for (const field of ["buildHash", "sourceCommit", "expectedProcess"] as const)
  test(
    "real MCP client: changed authority " + field + " sends no SDK request",
    async (t) => {
      const f = fixture(t, "success", "mcp");
      const authority = api.readJson(f.authorityEntry.path) as Record<
        string,
        unknown
      >;
      api.durable(f.authorityEntry.path, {
        ...authority,
        [field]:
          field === "expectedProcess"
            ? { pid: 1, birth: "foreign" }
            : "changed",
      });
      await assert.rejects(settled(f, "observe", f.message(":observe")));
      assert.equal(f.sdk(), 0);
    },
  );

test("broker script execution is absent from the discovery client", async () => {
  const { McpDiscoveryClient } = load(
    "../src/dist/fusion-transport/mcp",
  ) as typeof import("../packages/node-adapters/src/fusion-transport/mcp");
  const client = new McpDiscoveryClient(
    { url: "http://127.0.0.1:1/never-used" },
    { version: "offline", requestTimeout: () => 1000, bridgeSource: () => "" },
  );
  assert.equal("executeBrokerScript" in client, false);
  await assert.rejects(
    client.callTool({ code: "never sent" }, "execute_python"),
    { code: "QUEUE_REQUIRED" },
  );
});

test("real MCP client: fixed scratch close preserves origin and refuses changed source before discovery", async (t) => {
  t.after((load("./fixtures/fake-wsl-platform.cjs") as () => () => void)());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fixed-close-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { prepareScratchQualification } = load(
    "../src/queue-scratch-qualification",
  ) as typeof import("../src/queue-scratch-qualification");
  const { pythonArtifactManifest } = load(
    "../src/dist/python/context-binding",
  ) as typeof import("../packages/node-adapters/src/python/context-binding");
  const prepared = prepareScratchQualification(
    repository,
    {},
    {
      purpose: "isolated-scratch-close-v1",
      epochId: "offline-owned-epoch",
      sdkProofPath: path.join(directory, "sdk-closed.json"),
      document: {
        name: "FMCAD_ISOLATED_offline-owned-epoch",
        creationId: "offline-owned-creation",
        fileId: null,
      },
      restoreActiveCreationId: "offline-original-active",
    },
    { directory },
  );
  const origin = pythonArtifactManifest(prepared.artifact);
  let sends = 0;
  const { client, discoveryPosts } = mcpClient(async (payload) => {
    sends++;
    assert.equal(payload.params?.name, "fusion_mcp_execute");
    assert.deepEqual(payload.params?.arguments, {
      featureType: "script",
      object: { script: prepared.artifact.script, readOnly: false },
    });
    return {
      status: 200,
      raw: JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: { content: [{ type: "text", text: "offline-close" }] },
      }),
    };
  });
  await assert.rejects(
    async () =>
      client.executeBrokerScript(
        prepared.artifact.script + "\n# changed source",
        origin,
      ),
    { code: "PYTHON_CONTEXT_CHANGED" },
  );
  await assert.rejects(
    client.executeBrokerScript(prepared.artifact.script, {
      ...origin,
      sha256: "0".repeat(64),
    }),
    { code: "PYTHON_CONTEXT_CHANGED" },
  );
  await assert.rejects(async () =>
    Reflect.apply(client.executeBrokerScript, client, [
      prepared.artifact.script,
    ]),
  );
  assert.equal(discoveryPosts(), 0);
  assert.equal(sends, 0);
  await client.executeBrokerScript(prepared.artifact.script, origin);
  assert.equal(discoveryPosts(), 2);
  assert.equal(sends, 1);
});

async function settled(
  f: ReturnType<typeof fixture>,
  method: "observe" | "create",
  message: ReturnType<ReturnType<typeof fixture>["message"]>,
) {
  const deadline = Date.now() + 10000;
  let result = (await f.control[method](
    message,
    f.clientId,
  )) as unknown as Result;
  while (result.status === "pending" || f.busy()) {
    if (Date.now() > deadline)
      assert.fail("Synthetic successor operation did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
    result = (await f.control[method](
      message,
      f.clientId,
    )) as unknown as Result;
  }
  return result;
}

test("FAKE ports: current facts precede exactly one new scratch, old work stays immutable and no grant is copied", async (t) => {
  const f = fixture(t);
  const oldState = fs.readFileSync(f.authority.predecessor.state.path);
  await assert.rejects(f.control.create(f.message(":create"), f.clientId), {
    code: "EPOCH_AUDIT_REQUIRED",
  });
  assert.equal(f.sdk(), 0);
  const observed = await settled(f, "observe", f.message(":observe"));
  assert.equal(observed.status, "complete", JSON.stringify(observed));
  assert.equal(f.sdk(), 1);
  const start = api.readJson(
    path.join(f.audit, "dead-epoch-current-observation/start.json"),
  ) as StoredStart;
  assert.deepEqual(
    start.binding["auditExpectedProcess"],
    f.authority.expectedProcess,
  );
  const created = await settled(f, "create", f.message(":create"));
  assert.equal(created.status, "complete");
  assert.equal(created.activation.admission, "qualified-fresh-scratch-only");
  assert.equal(f.sdk(), 2);
  assert.ok(f.activations() >= 1);
  assert.notEqual(f.state.epoch!.epochId, f.authority.predecessor.epochId);
  assert.notEqual(
    f.state.epoch!.document.creationId,
    (
      api.readJson(f.authority.predecessor.pointer.path) as {
        document: { creationId: string };
      }
    ).document.creationId,
  );
  assert.deepEqual(
    fs.readFileSync(f.authority.predecessor.state.path),
    oldState,
  );
  assert.equal(f.state.status(f.priorJob.id)["quarantined"], true);
  assert.equal(
    fs
      .readdirSync(f.state.epoch!.root)
      .filter((name) => name.startsWith("access-")).length,
    0,
  );
  await f.control.create(f.message(":create"), f.clientId);
  assert.equal(
    f.sdk(),
    2,
    "Receipt reads never replay observation or creation",
  );
});

for (const mode of ["lost-observation", "lost-creation"])
  test(
    "FAKE ports: " + mode + " retains intent/unknown and never retries SDK",
    async (t) => {
      const f = fixture(t, mode);
      const observed = await settled(f, "observe", f.message(":observe"));
      let result = observed;
      if (mode === "lost-creation")
        result = await settled(f, "create", f.message(":create"));
      assert.equal(result.status, "failed");
      assert.equal(result.sdkRequestsSent, 1);
      const count = f.sdk();
      await f.control[mode === "lost-creation" ? "create" : "observe"](
        f.message(mode === "lost-creation" ? ":create" : ":observe"),
        f.clientId,
      );
      assert.equal(f.sdk(), count);
      assert.equal(f.state.epoch!.epochId, f.authority.predecessor.epochId);
      if (mode === "lost-observation")
        await assert.rejects(
          f.control.create(f.message(":create"), f.clientId),
          { code: "EPOCH_AUDIT_REQUIRED" },
        );
    },
  );

test("FAKE ports: foreign owner and a second request ID cannot obtain successor authority", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.control.observe(f.message(":observe"), "foreign"), {
    code: "NOT_OWNER",
  });
  await assert.rejects(f.control.observe(f.message(":different"), f.clientId), {
    code: "INVALID_REQUEST",
  });
  assert.equal(f.sdk(), 0);
});

for (const mode of ["unsafe-ui", "surviving-holder"])
  test(
    "FAKE ports: known " +
      mode +
      " observation cannot publish scratch authority",
    async (t) => {
      const f = fixture(t, mode);
      await assert.rejects(settled(f, "observe", f.message(":observe")), {
        code: "EPOCH_SUCCESSOR_FACTS_UNSAFE",
      });
      assert.equal(f.sdk(), 1);
      assert.equal(f.control.metadata().currentFactsAvailable, false);
      assert.equal(
        fs.existsSync(path.join(f.audit, "observed-current.json")),
        false,
      );
      await assert.rejects(f.control.create(f.message(":create"), f.clientId), {
        code: "EPOCH_AUDIT_REQUIRED",
      });
      assert.equal(f.sdk(), 1);
    },
  );
