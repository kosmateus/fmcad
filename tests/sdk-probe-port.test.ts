import type { WorkerSdkProbeRequest, WorkerRequest } from "@fmcad/core";
import type {
  Client,
  Origin,
  Rpc,
  ToolArguments,
} from "../src/queue-broker-ports";
import { createRequire } from "node:module";
import { at, text } from "./integration/offline-cli";
const testRoot = process.cwd();
const runtimeRequire = createRequire(
  testRoot + "/tests/sdk-probe-port.test.js",
);
function present<T>(value: T | null | undefined): T {
  assert(value != null);
  return value;
}
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
test.after(runtimeRequire("./fixtures/fake-wsl-platform.cjs")());
const { createWorkerSdkProbe, prepareSdkProbe } = runtimeRequire(
  "../packages/node-adapters/dist/execution/sdk-probe",
) as typeof import("../packages/node-adapters/src/execution/sdk-probe");
const { preparePythonArtifact } = runtimeRequire(
  "../src/python",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { serve } = runtimeRequire(
  "../src/queue-broker",
) as typeof import("../src/queue-broker");
const { request } = runtimeRequire(
  "../src/queue-connection",
) as typeof import("../src/entrypoints/queue-connection");
const { durable } = runtimeRequire("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;

function probeRequest(): WorkerSdkProbeRequest {
  return {
    capabilityId: "entity.list",
    backend: "mcp",
    documentIdentity: { docId: "creation-1", docFileId: "file-1" },
  };
}
function workerRequest(): WorkerRequest {
  return {
    cwd: "/project",
    argv: [
      "capabilities",
      "probe",
      "--doc",
      "Model",
      "--doc-id",
      "creation-1",
      "--doc-file-id",
      "file-1",
    ],
    payload: {
      version: 1,
      kind: "cad",
      operation: "capabilities.probe",
      doc: "Model",
      docId: "creation-1",
      docFileId: "file-1",
      data: { capabilityId: "entity.list" },
    },
  };
}
const artifact = () =>
  preparePythonArtifact([
    {
      id: "test",
      filename: "test.py",
      role: "wrapper",
      source: "def run(context): pass",
    },
  ]);
function observed(
  input: Pick<WorkerSdkProbeRequest, "capabilityId">,
  registered = true,
) {
  return {
    failed: false,
    text:
      "FMCAD_SDK_PROBE " +
      JSON.stringify({
        capabilityId: input.capabilityId,
        registered,
        build: "native-fixture-version",
        docId: "creation-1",
        docFileId: "file-1",
      }),
  };
}

test("typed probe port binds its accepted operation/backend/pins before any physical executor", async () => {
  let calls = 0;
  const port = createWorkerSdkProbe({
    request: workerRequest(),
    backend: "mcp",
    prepare: artifact,
    async execute() {
      calls++;
      return observed(probeRequest());
    },
  });
  for (const invalid of [
    { ...probeRequest(), backend: "addin" },
    { ...probeRequest(), capabilityId: "model.delete" },
    { ...probeRequest(), documentIdentity: { docId: "foreign" } },
    { ...probeRequest(), documentIdentity: {} },
  ] as const)
    await assert.rejects(port.probe(invalid));
  assert.equal(calls, 0);
  const evidence = await port.probe(probeRequest());
  assert.equal(calls, 1);
  assert.equal(evidence.status, "partial");
  assert.equal(evidence.precision, "unknown");
  assert.equal(evidence.identity, "verified");
  assert.equal(evidence.mutation, "none");
  assert.match(evidence.limitations.join(" "), /not behavioral execution/);
  const foreign = createWorkerSdkProbe({
    request: {
      ...workerRequest(),
      payload: { ...workerRequest().payload, operation: "entity.list" },
    },
    backend: "mcp",
    prepare: artifact,
    async execute() {
      calls++;
    },
  });
  await assert.rejects(foreign.probe(probeRequest()), {
    code: "INVALID_PROBE_TARGET",
  });
  assert.equal(calls, 1);
});

test("native missing handler, invalid evidence and lost observation never become passing capability or a retry", async () => {
  for (const mode of ["missing", "malformed", "foreign", "lost"]) {
    let calls = 0;
    const port = createWorkerSdkProbe({
      request: workerRequest(),
      backend: "mcp",
      prepare: artifact,
      async execute() {
        calls++;
        if (mode === "lost")
          throw Object.assign(new Error("reply lost"), { code: "ECONNRESET" });
        if (mode === "malformed") return { failed: false, text: "no evidence" };
        return observed(
          mode === "foreign"
            ? { capabilityId: "other.operation" }
            : probeRequest(),
          false,
        );
      },
    });
    if (mode === "missing")
      assert.equal((await port.probe(probeRequest())).status, "unsupported");
    else await assert.rejects(port.probe(probeRequest()));
    assert.equal(calls, 1);
  }
});

test("probe preparation uses actual SDK build/document assertions and loaded registry without invoking a handler", () => {
  const prepared = prepareSdkProbe(
    path.resolve(testRoot + "/tests", ".."),
    probeRequest(),
    {
      doc: "Model",
      docId: "creation-1",
      docFileId: "file-1",
      capabilityId: "entity.list",
    },
  );
  const wrapper = present(
    prepared.units.find((unit) => unit.id === "wrapper"),
  ).source;
  assert.match(wrapper, /adsk\.core\.Application\.get\(\)/);
  assert.match(wrapper, /_document_assert_identity\(doc,/);
  assert.match(wrapper, /str\(app\.version\)/);
  assert.match(wrapper, / in CAD_HANDLERS/);
  assert.doesNotMatch(
    wrapper,
    /CAD_HANDLERS\[|doc\.activate|_document_activate_target|cad_dispatch/,
  );
  assert.ok(prepared.units.some((unit) => unit.id === "identity"));
  assert.ok(
    prepared.units.length > 20,
    "probe inspects the loaded full runtime, not the local catalog only",
  );
});

test(
  "real worker probe port executes through broker IPC/admission/receipts/postflight and has no direct transport",
  {},
  async (t) => {
    const dir = fs.mkdtempSync("/tmp/opencode/sdk-probe-port-");
    const entrypoint = path.join(dir, "probe-worker.cjs");
    const preload = runtimeRequire.resolve("./fixtures/fake-wsl-preload.cjs");
    const input = probeRequest();
    const typed = (
      runtimeRequire(
        "../src/cad-service",
      ) as typeof import("../src/composition/cad-service")
    ).fromParsedCommand({
      kind: "cad",
      operation: "capabilities.probe",
      data: { capabilityId: input.capabilityId },
      context: { doc: "Model", docId: "creation-1", docFileId: "file-1" },
      json: true,
    });
    const acceptedRequest = {
      cwd: dir,
      argv: typed.argv,
      payload: typed.payload,
      inputFiles: [],
    };
    fs.writeFileSync(
      entrypoint,
      `const Module=require('node:module'),load=Module._load;
Module._load=function(name,parent,...rest){if((name==='./cli'||name.endsWith('/cli'))&&parent?.filename.includes('/src/'))throw Error('worker CLI forbidden');return load.call(this,name,parent,...rest)};
require(${JSON.stringify(runtimeRequire.resolve("../src/queue-worker"))}).run(process.argv[2])
  .then(code=>{process.exitCode=code},error=>{process.stderr.write(error.stack+'\\n');process.exitCode=1});
`,
    );
    const instance = {
      pid: 99,
      birth: "mock:99",
      version: "native-fixture-version",
      activeCommand: "SelectCommand",
      documents: [],
      documentState: {
        status: "complete",
        fingerprint: "stable",
        state: {
          identity: { creationId: "creation-1", fileId: "file-1" },
          references: [],
        },
      },
    };
    let physicalCalls = 0;
    const stages: string[] = [];
    const emitReceipt = (script: string) => {
      const binding = script.match(
        /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/,
      );
      const file = script.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
      if (!binding || !file) throw new Error("broker receipt binding missing");
      const target = JSON.parse(present(file[1]))
        .replace(/^\\\\wsl\$\\[^\\]+/, "")
        .replaceAll("\\", "/");
      durable(target, {
        ...JSON.parse(JSON.parse(present(binding[1]))),
        terminal: true,
        outcome: "succeeded",
        instance,
      });
    };
    const physical = {
      server: { timeoutMs: 10000 },
      _parse: JSON.parse,
      async prepareCallTool(
        value: ToolArguments,
        name = "fusion_mcp_execute",
        origin?: Origin,
      ) {
        const client = this as unknown as Client;
        const prepared = await client.preparePost!(
          {
            jsonrpc: "2.0",
            id: randomUUID(),
            method: "tools/call",
            params: { name, arguments: value },
          },
          origin,
        );
        return Object.assign(
          async () => {
            const response = await prepared.send();
            const content = JSON.parse(response.raw).result.content;
            return {
              failed: false,
              text: content
                .map((item: { text: string }) => item.text)
                .join("\n"),
            };
          },
          {
            fence: () => prepared.fence(),
          },
        );
      },
      async _post(payload: Rpc) {
        const script = text(
          at(payload, "params", "arguments", "object", "script"),
        );
        if (script.includes("FMCAD_QUEUE_INSTANCE")) {
          emitReceipt(script);
          stages.push(
            script.includes("postflight-")
              ? "postflight"
              : script.includes("preflight-")
                ? "preflight"
                : "startup",
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
                    text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance),
                  },
                ],
              },
            }),
          };
        }
        physicalCalls++;
        assert.equal(
          at(payload, "params", "arguments", "object", "readOnly"),
          true,
        );
        assert.match(script, /FMCAD_SDK_PROBE/);
        emitReceipt(script);
        stages.push("sdk");
        return {
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { content: [{ type: "text", text: observed(input).text }] },
          }),
        };
      },
      async callTool(value: ToolArguments) {
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
      { backend: "mcp", timeoutMs: 10000 },
      {
        dir,
        confirmOwnership: true,
        createBackend: () => physical as unknown as Client,
        pollMs: 5,
        spawnWorker: ((
          executable: string,
          args: readonly string[] = [],
          options: import("node:child_process").SpawnOptions = {},
        ) =>
          spawn(executable, [entrypoint, present(args[1])], {
            ...options,
            env: {
              ...options.env,
              NODE_OPTIONS: [
                options.env?.["NODE_OPTIONS"],
                "--require",
                preload,
              ]
                .filter(Boolean)
                .join(" "),
            },
          })) as typeof spawn,
      },
    );
    t.after(async () => {
      await broker.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const auth = { clientId: "probe-client", clientToken: "probe-token" };
    await request(dir, { action: "register", ...auth });
    const job = await request(dir, {
      action: "submit",
      auth,
      request: {
        ...acceptedRequest,
        kind: "command",
        requestId: randomUUID(),
        buildHash: (
          runtimeRequire("../src/queue-instance") as ReturnType<
            typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
          >
        ).buildHash(),
        timeoutMs: 10000,
      },
    });
    let result;
    for (;;) {
      result = await request(dir, {
        action: "result",
        auth,
        jobId: text(at(job, "id")),
      });
      if (
        ["succeeded", "failed", "needs_reconciliation"].includes(
          text(at(result, "job", "state")),
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(at(result, "job", "state"), "failed", JSON.stringify(result));
    assert.equal(JSON.parse(text(at(result, "stdout"))).status, "partial");
    assert.equal(JSON.parse(text(at(result, "stdout"))).success, false);
    assert.equal(
      JSON.parse(text(at(result, "stdout"))).result.build,
      instance.version,
    );
    assert.equal(physicalCalls, 1);
    assert.deepEqual(stages.slice(-3), ["preflight", "sdk", "postflight"]);
    assert.equal(broker.status().blocked, null);
    const journals = fs
      .readdirSync(path.join(dir, "jobs", text(at(job, "id"))))
      .filter((name) => /^rpc-.*\.json$/.test(name));
    assert.equal(journals.length, 1);
    const journal = JSON.parse(
      fs.readFileSync(
        path.join(dir, "jobs", text(at(job, "id")), present(journals[0])),
        "utf8",
      ),
    );
    assert.equal(journal.remoteReceipt.outcome, "succeeded");
    assert.ok(journal.pythonArtifact.sha256);
  },
);
