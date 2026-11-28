"use strict";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isolateRuntimeTestEnvironment } from "./runtime-test-environment.js";

type JsonRecord = Record<string, unknown>;
type QueueJobResult = {
  job: { id: string; kind?: string; state: string };
  stdout: string;
  stderr: string;
  execution?: { mayHaveMutated?: boolean };
  pythonChecks?: Array<{
    status?: string;
    provenance?: {
      checker?: string;
      checkerVersion?: string;
      definitionsHash?: string | null;
      pythonVersion?: string;
    };
  }>;
};
type Broker = { close(): Promise<void> };
type BrokerTransport = Record<string, unknown>;
type NativeRequest = {
  jsonrpc: string;
  id: string | number;
  method: string;
  params: {
    name: string;
    arguments: {
      featureType: string;
      object: { script: string; readOnly?: boolean };
    };
  };
};
type NativeEndpoint = {
  requests: Array<{
    method: string;
    id?: string | number;
    readOnly?: boolean;
    readOnlyField?: unknown;
    script?: string;
    decodedScript?: string;
    wire?: NativeRequest;
  }>;
  responses: Array<{ status: number; body?: JsonRecord }>;
  violations: string[];
  readonly writeCount: number;
  listen(): Promise<string>;
  close(): Promise<void>;
};
type HistoricalContractFixture = {
  historical: {
    commit: string;
    runBlob: string;
    cadServiceBlob: string;
    toolName: string;
    featureType: string;
    readOnly: boolean;
    writeReadOnlyField: string;
  };
  pythonSource: string;
  createNativeContractEndpoint(options: {
    root: string;
    instance: JsonRecord;
    token: string;
    protocolVersion: string;
  }): NativeEndpoint;
};

const projectRoot = path.resolve(__dirname, "..", "..");
const runtimeRoot = process.env["FMCAD_TEST_RUNTIME_ROOT"];
const runtimeRequire = createRequire(__filename);
const sourceRoot = runtimeRoot ?? projectRoot;
const brokerPath = runtimeRoot
  ? path.join(runtimeRoot, "dist/src/queue-broker.js")
  : path.join(projectRoot, "src/queue-broker.js");
const requestPath = runtimeRoot
  ? path.join(runtimeRoot, "dist/src/queue-connection.js")
  : path.join(projectRoot, "src/queue-connection.js");
const { serve } = runtimeRequire(brokerPath) as {
  serve(config: JsonRecord, options: JsonRecord): Promise<Broker>;
};
const request = runtimeRequire(requestPath).request as <
  T extends object = JsonRecord,
>(
  directory: string,
  message: JsonRecord,
) => Promise<T>;
const { createBrokerTransport } = runtimeRequire(
  runtimeRoot
    ? path.join(runtimeRoot, "dist/src/dist/fusion-transport/broker.js")
    : path.join(
        projectRoot,
        "packages/node-adapters/dist/fusion-transport/broker.js",
      ),
) as {
  createBrokerTransport(
    server: JsonRecord,
    options: {
      version: string;
      requestTimeout(server: JsonRecord): number;
      bridgeSource(): string;
    },
  ): BrokerTransport;
};
const { requestTimeout } = runtimeRequire(
  runtimeRoot
    ? path.join(runtimeRoot, "dist/src/request-timeout.js")
    : path.join(projectRoot, "src/request-timeout.js"),
) as { requestTimeout(server: JsonRecord): number };
const { version } = runtimeRequire(path.join(sourceRoot, "package.json")) as {
  version: string;
};
const fixture = runtimeRequire(
  path.join(projectRoot, "tests/fixtures/generic-native-write-contract.cjs"),
) as HistoricalContractFixture;

function isolatedBrokerBackend(server: JsonRecord): BrokerTransport {
  return createBrokerTransport(server, {
    version,
    requestTimeout,
    bridgeSource: () => "",
  });
}

function object(value: unknown): JsonRecord {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as JsonRecord;
}

test("queued generic write uses the native readOnly boolean contract", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-generic-native-write-"),
  );
  const isolatedEnvironment = isolateRuntimeTestEnvironment(root);
  const queueDirectory = path.join(root, "queue");
  const scriptPath = path.join(root, "generic-owned-write.py");
  fs.writeFileSync(scriptPath, fixture.pythonSource, { mode: 0o600 });
  const sourceHash = createHash("sha256")
    .update(fs.readFileSync(scriptPath))
    .digest("hex");
  const docId = "synthetic-creation-0001";
  const docName = "Synthetic Owned Fixture";
  const instance = {
    pid: 4242,
    birth: "synthetic:generic-native-write",
    version: "synthetic-fusion",
    activeCommand: "SelectCommand",
    documents: [
      {
        id: docId,
        name: docName,
        fileId: null,
        isSaved: false,
        isModified: false,
      },
    ],
    documentState: {
      status: "complete",
      fingerprint: "synthetic-document-state",
      state: {
        identity: {
          creationId: docId,
          name: docName,
          fileId: null,
          isSaved: false,
        },
      },
    },
  };
  const token = "Bearer synthetic-generic-contract";
  const protocolVersion = "2025-06-18";
  const endpoint = fixture.createNativeContractEndpoint({
    root,
    instance,
    token,
    protocolVersion,
  });
  const brokerPromise = (async () => {
    const url = await endpoint.listen();
    const config = {
      backend: "mcp",
      routing: "queue",
      url,
      timeoutMs: 180_000,
      tool: fixture.historical.toolName,
      transport: "node",
      protocolVersion,
      headers: { Authorization: token },
    };
    return serve(config, {
      dir: queueDirectory,
      confirmOwnership: true,
      pollMs: 5,
      createBackend: isolatedBrokerBackend,
      nativePath: (file: string) => file,
    });
  })();
  t.after(async () => {
    try {
      const broker = await brokerPromise.catch(() => undefined);
      await broker?.close();
    } finally {
      try {
        await endpoint.close();
      } finally {
        isolatedEnvironment.restore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  await brokerPromise;

  const auth = {
    clientId: "synthetic-generic-write-owner",
    clientToken: "synthetic-generic-write-token",
  };
  await request(queueDirectory, { action: "register", ...auth });

  const payload = {
    version: 1,
    kind: "run",
    request: {
      name: scriptPath,
      args: [],
      hasArgs: false,
      doc: docName,
      identity: { docId, readOnly: false },
      readOnlyOperations: [],
    },
  };
  const argv = ["run", scriptPath, "--doc-id", docId, "--doc", docName];
  const submitted = await request<{ id: string }>(queueDirectory, {
    action: "submit",
    auth,
    request: {
      kind: "command",
      requestId: randomUUID(),
      cwd: root,
      argv,
      payload,
      inputFiles: [{ path: path.basename(scriptPath), sha256: sourceHash }],
      description: "Synthetic owned generic write contract",
      timeoutMs: 180_000,
    },
  });

  const deadline = Date.now() + 370_000;
  let completed: QueueJobResult | undefined;
  while (Date.now() < deadline) {
    completed = await request<QueueJobResult>(queueDirectory, {
      action: "result",
      auth,
      jobId: submitted.id,
    });
    if (
      ["succeeded", "failed", "needs_reconciliation", "expired"].includes(
        completed.job.state,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(completed, "queued generic write returned a public result");
  assert.equal(completed.job.id, submitted.id);
  assert.equal(completed.job.kind, "command");
  assert.equal(completed.job.state, "succeeded", JSON.stringify(completed));
  assert.equal(completed.execution?.mayHaveMutated, true);
  assert.equal(
    completed.stdout,
    'FMCAD_RESULT {"success":true,"parameter":"OwnedCounter"}\n',
  );

  const writes = endpoint.requests.filter(
    (entry) =>
      entry.method === "tools/call" &&
      entry.decodedScript?.includes("OwnedCounter"),
  );
  assert.equal(endpoint.writeCount, 1);
  assert.equal(writes.length, 1);
  const captured = writes[0];
  assert.ok(captured?.wire);
  const finalScript = captured.decodedScript;
  const wireScript = captured.script;
  assert.ok(finalScript);
  assert.ok(wireScript);
  assert.equal(captured.readOnly, false);
  assert.equal(captured.readOnlyField, undefined);
  assert.deepEqual(captured.wire, {
    jsonrpc: "2.0",
    id: captured.wire.id,
    method: "tools/call",
    params: {
      name: fixture.historical.toolName,
      arguments: {
        featureType: fixture.historical.featureType,
        object: {
          script: wireScript,
          ...(captured.readOnlyField === undefined
            ? {}
            : { readOnly: captured.readOnlyField }),
        },
      },
    },
  });
  assert.equal(captured.wire.params.name, "fusion_mcp_execute");
  assert.equal(captured.wire.params.arguments.featureType, "script");
  assert.equal(captured.wire.params.arguments.object.readOnly, undefined);
  assert.match(finalScript, /def run\(_context: str\) -> None:/);
  assert.match(finalScript, /_qr_run = _qr_namespace\['run'\]/);
  assert.match(
    finalScript,
    /_qr_cast\(_qr_Callable\[\[str\], object\], _qr_run\)\(_context\)/,
  );
  assert.match(finalScript, /OwnedCounter/);
  assert.doesNotMatch(finalScript, /run\(""\)\s*$/);
  const finalResponse = endpoint.responses.find(
    (entry) => entry.body?.["id"] === captured.wire!.id,
  );
  assert.ok(finalResponse, "fake native MCP response was captured");
  assert.equal(finalResponse.status, 200);
  assert.equal(finalResponse.body?.["jsonrpc"], "2.0");
  assert.equal(finalResponse.body?.["id"], captured.wire.id);
  const result = object(finalResponse.body?.["result"]);
  assert.deepEqual(result["content"], [
    {
      type: "text",
      text: 'FMCAD_RESULT {"success":true,"parameter":"OwnedCounter"}',
    },
  ]);
  assert.deepEqual(endpoint.violations, []);
  assert.equal(
    endpoint.requests.filter((entry) => entry.method === "initialize").length,
    endpoint.requests.filter(
      (entry) => entry.method === "notifications/initialized",
    ).length,
  );
  assert.ok(
    endpoint.requests.some(
      (entry) => entry.method === "tools/call" && entry.readOnly === true,
    ),
    "synthetic instance probes retain their read-only classification",
  );
  assert.ok(
    endpoint.requests.some(
      (entry) =>
        entry.method === "tools/call" &&
        entry.readOnly === true &&
        entry.readOnlyField === true,
    ),
    "read-only calls use the explicit native boolean field",
  );

  const typingRoot = runtimeRoot
    ? path.join(runtimeRoot, "dist/runtime/python/typing")
    : path.join(projectRoot, "dist/runtime/python/typing");
  const definitionsPointer = JSON.parse(
    fs.readFileSync(path.join(typingRoot, "current.json"), "utf8"),
  ) as { snapshot?: unknown };
  assert.equal(typeof definitionsPointer.snapshot, "string");
  const reports = completed.pythonChecks ?? [];
  const passed = reports.find((report) => report.status === "passed");
  assert.ok(passed, "production Python admission returned a passed report");
  assert.equal(passed.provenance?.checker, "basedpyright");
  assert.equal(passed.provenance?.checkerVersion, "1.40.2");
  assert.equal(passed.provenance?.pythonVersion, "3.11");
  assert.equal(passed.provenance?.definitionsHash, definitionsPointer.snapshot);

  // This official run route preserves its omitted write flag. The separate
  // public execute_python qualification requires explicit readOnly=false; the
  // schema's boolean field does not make this route's wire history equivalent.
  // The official wrapper owns run(context) and its terminal receipt.
  assert.equal(
    fixture.historical.commit,
    "e4994e96d6dbf4fdb975bf66dba3e45c05b33a93",
  );
  assert.equal(
    fixture.historical.runBlob,
    "c9fc25d138cf028e446963539eb7b51d3f728e94",
  );
  assert.equal(
    fixture.historical.cadServiceBlob,
    "788495997a5703261e426c38ddacc76ff6bb5e15",
  );
  assert.equal(fixture.historical.toolName, captured.wire.params.name);
  assert.equal(
    fixture.historical.featureType,
    captured.wire.params.arguments.featureType,
  );
  assert.equal(fixture.historical.readOnly, captured.readOnly);
  assert.equal(fixture.historical.writeReadOnlyField, "omitted");
  assert.equal(captured.readOnlyField, undefined);

  t.diagnostic(
    JSON.stringify({
      sourceHash,
      finalScript: {
        sha256: createHash("sha256").update(finalScript).digest("hex"),
        bytes: Buffer.byteLength(finalScript),
      },
      wireScript: {
        sha256: createHash("sha256").update(wireScript).digest("hex"),
        bytes: Buffer.byteLength(wireScript),
      },
      wireRequest: {
        jsonrpc: captured.wire.jsonrpc,
        id: captured.wire.id,
        method: captured.wire.method,
        name: captured.wire.params.name,
        featureType: captured.wire.params.arguments.featureType,
        objectKeys: Object.keys(captured.wire.params.arguments.object),
        scriptSha256: createHash("sha256")
          .update(captured.wire.params.arguments.object.script)
          .digest("hex"),
      },
      wrapper: {
        officialEntrypoint: "run(_context: str)",
        autoRun: "_qr_run(_context)",
        readOnly: captured.readOnly,
        readOnlyField: captured.readOnlyField,
      },
      checker: passed.provenance,
      response: {
        http: finalResponse.status,
        jsonrpc: finalResponse.body?.["jsonrpc"],
        id: finalResponse.body?.["id"],
        classification: "success",
        text: completed.stdout.trimEnd(),
      },
      historical: fixture.historical,
    }),
  );
});
