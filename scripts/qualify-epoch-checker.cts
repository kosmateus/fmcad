#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type {
  PreparedPythonArtifact,
  PythonArtifactManifest,
  PythonCheckReport,
} from "@fmcad/core";
const load = createRequire(__filename);
interface Rpc {
  params: { arguments: { code: string } };
  [key: string]: unknown;
}
interface Physical {
  _post(): never;
  preparePost(
    payload: Rpc,
    origin: PythonArtifactManifest,
  ): Promise<{ fence(): void; send(): never }>;
  prepareCallTool(
    request: { featureType: string; object: { script: string } },
    tool: string,
    origin: PythonArtifactManifest,
  ): Promise<unknown>;
}
interface Fixture {
  dir: string;
  nonce: string;
  cfg: unknown;
  paused: unknown;
  pointer: { root: string; epochId: string };
  approval: { settledJobIds: string[]; settledEvidenceHash: string };
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}
function json(file: string): Record<string, unknown> {
  return object(JSON.parse(fs.readFileSync(file, "utf8")) as unknown);
}

// Actual installed candidate + actual accepted smoke invocation, OFFLINE ONLY.
async function main() {
  const opts: Record<string, string> = {},
    args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      ![
        "--runtime",
        "--source-commit",
        "--request",
        "--output",
        "--fixture",
        "--settled",
      ].includes(key) ||
      opts[key] ||
      !value
    )
      throw new Error(
        "Exact installed runtime/source/request/output/fixture required",
      );
    opts[key] = value;
  }
  const runtime = opts["--runtime"],
    output = opts["--output"];
  if (opts["--settled"] !== undefined && opts["--settled"] !== "true")
    throw new Error("--settled supports only true");
  const settled = opts["--settled"] === "true";
  if (
    !runtime ||
    !output ||
    !path.isAbsolute(runtime) ||
    !path.isAbsolute(output || "") ||
    output.startsWith(runtime + path.sep) ||
    !/^[a-f0-9]{40}$/.test(opts["--source-commit"] || "")
  )
    throw new Error(
      "Explicit canonical runtime and private external output required",
    );
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const api = load(runtime + "/src/queue-instance") as {
    buildHash(root: string): string;
    hash(value: string | Uint8Array): string;
    prepareReceiptScript(
      code: string,
      official: boolean,
      receipt: string,
      binding: Record<string, string>,
    ): PreparedPythonArtifact;
  };
  const py = load(runtime + "/src/python") as {
    retainPythonOrigin(
      artifact: PreparedPythonArtifact,
      origin: PythonArtifactManifest,
    ): PreparedPythonArtifact;
    pythonArtifactManifest(
      artifact: PreparedPythonArtifact,
    ): PythonArtifactManifest;
  };
  const codeHash = api.buildHash(runtime);
  assert.equal(codeHash, json(runtime + "/runtime-build.json")["fingerprint"]);
  const requestPath = text(opts["--request"]);
  const request = object(json(requestPath)["request"]);
  const invocation = object(request["payload"]);
  assert.equal(invocation["operation"], "sketch.create");
  const cad = load(runtime + "/src/cad") as {
    prepareCadScript(
      operation: string,
      data: unknown,
      options: { doc: string; docId: string; preview: boolean },
    ): PreparedPythonArtifact;
  };
  const artifact = cad.prepareCadScript(
    text(invocation["operation"]),
    invocation["data"],
    {
      doc: text(invocation["doc"]),
      docId: text(invocation["docId"]),
      preview: invocation["preview"] === true,
    },
  );
  const transport = load(runtime + "/src/dist/fusion-transport/broker") as {
    createBrokerTransport(
      server: { backend: string; url: string; timeoutMs: number },
      ports: {
        version: string;
        requestTimeout(server: { timeoutMs: number }): number;
        bridgeSource(): never;
      },
    ): Physical;
  };
  const physical = transport.createBrokerTransport(
    {
      backend: "addin",
      url: "http://NEVER-SEND.invalid",
      timeoutMs: 180000,
    },
    {
      version: "installed-offline-qualification",
      requestTimeout: (s) => s.timeoutMs,
      bridgeSource: () => assert.fail("No alternate bridge"),
    },
  );
  physical._post = () => assert.fail("NO HTTP OR SDK in offline qualification");
  const admission = load(runtime + "/src/queue-admission") as {
    createProductionQueueAdmission(runtime: string): {
      admission: {
        check(
          payload: Rpc,
          artifact: PreparedPythonArtifact,
        ): Promise<{ report: PythonCheckReport; fence(payload: Rpc): void }>;
      };
    };
  };
  const production = admission.createProductionQueueAdmission(
    runtime + "/runtime/python",
  );
  let report: PythonCheckReport | undefined,
    finalArtifactHash: string | undefined;
  physical.preparePost = async (payload, origin) => {
    const code = payload.params.arguments.code;
    assert.ok(code.includes("FMCAD_UI_GUARD"));
    const final = py.retainPythonOrigin(
      api.prepareReceiptScript(
        code,
        false,
        path.join(output, "never-sent.json"),
        {
          jobId: "offline-accepted-smoke-invocation",
          rpcId: "offline",
          requestHash: api.hash(JSON.stringify(payload)),
          sourceHash: api.hash(code),
          buildHash: codeHash,
        },
      ),
      origin,
    );
    const outgoing = {
      ...payload,
      params: {
        ...payload.params,
        arguments: { ...payload.params.arguments, code: final.script },
      },
    };
    const certificate = await production.admission.check(outgoing, final);
    report = certificate.report;
    finalArtifactHash = final.artifactHash;
    assert.equal(report.status, "passed");
    assert.equal(report.provenance.checker, "basedpyright");
    certificate.fence(outgoing);
    const altered = structuredClone(outgoing);
    altered.params.arguments.code += "\n# changed bytes";
    assert.throws(() => certificate.fence(altered));
    const forged = structuredClone(final),
      originRecord = object(object(forged.context)["origin"]);
    const segments = originRecord["segments"];
    assert.ok(Array.isArray(segments));
    const segment = object(segments[0]);
    assert.ok(typeof segment["startLine"] === "number");
    segment["startLine"] += 1;
    await assert.rejects(production.admission.check(outgoing, forged));
    return {
      fence() {},
      send() {
        assert.fail("No prepared send");
      },
    };
  };
  await physical.prepareCallTool(
    { featureType: "script", object: { script: artifact.script } },
    "fusion_mcp_execute",
    py.pythonArtifactManifest(artifact),
  );
  assert.ok(report);
  assert.equal(fs.existsSync(path.join(output, "never-sent.json")), false);
  // Real packaged broker startup, explicit synthetic filesystem/physical fixture.
  const fixtureRoot = path.join(output, "startup-fixture");
  fs.mkdirSync(fixtureRoot, { mode: 0o700 });
  const createFixture = load(text(opts["--fixture"])) as (
    root: string,
    runtime: string,
  ) => Fixture;
  const f = createFixture(fixtureRoot, runtime),
    original = fs.readFileSync(path.join(f.dir, "queue-state.json"));
  const upgrades = load(runtime + "/src/queue-epoch-runtime-upgrade") as {
    assertSettledEpochUpgrade(
      snapshot: unknown,
      approval: unknown,
      options: { paused: boolean },
    ): void;
  };
  if (settled)
    upgrades.assertSettledEpochUpgrade(f.paused, f.approval, { paused: true });
  const epochState = fs.readFileSync(
    path.join(f.pointer.root, "queue-state.json"),
  );
  let sends = 0;
  const host = load(runtime + "/src/queue-broker") as {
    serve(
      cfg: unknown,
      options: {
        dir: string;
        confirmOwnership: true;
        epochRuntimeUpgradeNonce: string;
        autoReconcile: false;
        createBackend(): {
          server: { timeoutMs: number };
          _parse: typeof JSON.parse;
          _post(): never;
          callTool(): never;
        };
      },
    ): Promise<{
      status(): { admissionEpoch: string };
      close(): Promise<void>;
    }>;
  };
  const broker = await host.serve(f.cfg, {
    dir: f.dir,
    confirmOwnership: true,
    epochRuntimeUpgradeNonce: f.nonce,
    autoReconcile: false,
    createBackend: () => ({
      server: { timeoutMs: 1000 },
      _parse: JSON.parse,
      _post() {
        sends++;
        assert.fail("No startup SDK");
      },
      callTool() {
        sends++;
        assert.fail("No probe");
      },
    }),
  });
  assert.equal(sends, 0);
  assert.equal(broker.status().admissionEpoch, f.pointer.epochId);
  assert.deepEqual(
    fs.readFileSync(path.join(f.dir, "queue-state.json")),
    original,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(f.pointer.root, "queue-state.json")),
    epochState,
  );
  await broker.close();
  const publicClient = load(runtime + "/src/client") as {
    McpClient: new (options: { routing: string }) => {
      callTool(): Promise<unknown>;
    };
  };
  await assert.rejects(
    new publicClient.McpClient({ routing: "direct" }).callTool(),
    { code: "QUEUE_REQUIRED" },
  );
  const result = {
    version: 1,
    qualifiedAt: new Date().toISOString(),
    sourceCommit: opts["--source-commit"],
    buildHash: codeHash,
    passed: true,
    productionAdmission: true,
    epochRuntimeUpgradeQualified: true,
    actualAcceptedInvocation: {
      requestId: request["requestId"],
      operation: invocation["operation"],
      invocationHash: api.hash(JSON.stringify(invocation)),
      reference: {
        path: opts["--request"],
        sha256: api.hash(fs.readFileSync(requestPath)),
      },
    },
    actualInstalledRealAddinUiGuard: true,
    completeOriginRuntimeUnits: artifact.units.length,
    finalArtifactHash,
    realChecker: report,
    finalByteTamperRejected: true,
    forgedOriginSegmentRejected: true,
    installedMetadataOnlyEpochStartup: true,
    syntheticStartupHistoryByteIdentical: true,
    publicDirectAccessRejected: true,
    liveSdkRequestsSent: 0,
    actualModelGeometryValidated: false,
    historicalOutcome: "unknown",
    modelValidation: "not_performed",
    rollbackVerification: "not_performed",
    ...(settled
      ? {
          settledEpochRuntimeUpgradeQualified: true,
          syntheticSettledJobs: f.approval.settledJobIds.length,
          syntheticSettledEvidenceHash: f.approval.settledEvidenceHash,
        }
      : {}),
  };
  fs.writeFileSync(
    path.join(output, "installed-qualification.json"),
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        sourceCommit: result.sourceCommit,
        buildHash: codeHash,
        actualInstalledRealAddinUiGuard: true,
        actualAcceptedInvocationHash:
          result.actualAcceptedInvocation.invocationHash,
        sdkRequestsSent: 0,
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
