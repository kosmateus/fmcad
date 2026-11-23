import assert from "node:assert/strict";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createBrokerRpcPreparation,
  type BrokerRpcPreparationPorts,
} from "../src/broker-rpc-preparation";
import type * as P from "../src/queue-broker-ports";
import type { BrokerModules } from "../src/queue-broker-modules";
import { prepareMetadataWire } from "../src/queue-broker-modules";
import { prepareBrokerScript } from "../packages/node-adapters/src/execution/broker-preparation";
import { createQueueInstance } from "../packages/node-adapters/src/execution/queue-instance";
import * as platform from "../packages/node-adapters/src/config-platform";
import { createPythonRpcAdmission } from "../packages/node-adapters/src/python/admission";
import { createPythonChecker } from "../packages/node-adapters/src/python/checker";
import { prepareWireArtifact } from "../packages/node-adapters/src/python/source-units";
import {
  retainPythonOrigin,
  pythonArtifactManifest,
} from "../packages/node-adapters/src/python/context-binding";
import { verifyPythonArtifact } from "../packages/node-adapters/src/python/artifact";
import {
  prepare,
  createTurnIdentity,
  executeTurn,
} from "../packages/core/src/application/broker-execution";
import type {
  PythonCheckReport,
  PreparedPythonArtifact,
} from "../packages/core/src";

const runtime = platform.resolveRuntimePaths({
  anchor: path.resolve("src/queue-broker.js"),
}).runtime;
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const instance: P.Instance = { pid: 41, birth: "original", version: "test" };
const otherInstance: P.Instance = { pid: 42, birth: "next", version: "test" };
const job = Object.freeze({
  id: "owned-job",
  request: {
    kind: "command" as const,
    clientId: "client",
    requestId: "request",
    timeoutMs: 4000,
  },
});
const python = (source = "answer: int = 42"): P.Rpc => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "execute_python",
    arguments: { code: source, persistent: false, extra: { retained: true } },
  },
});
function report(artifact: PreparedPythonArtifact): PythonCheckReport {
  return {
    status: "passed",
    diagnostics: [],
    reasons: [],
    provenance: {
      artifactHash: artifact.artifactHash,
      wireHash: artifact.sha256,
      analysisHash: "analysis",
      checkerHash: "checker",
      configHash: "config",
      typingHash: "typing",
      checker: "fixture",
      checkerVersion: "fixture",
      pythonVersion: "3.11",
      pythonInterpreterVersion: null,
      definitionsHash: null,
      contextHash: "fixture",
      cache: "disabled",
    },
  };
}
function fixture() {
  const trace: string[] = [];
  const view: ReturnType<BrokerRpcPreparationPorts["view"]> extends Readonly<
    infer V
  >
    ? V
    : never = {
    epoch: null,
    admissionMode: "normal-multidocument",
    contextEpoch: 7,
    approvedRuntimeRoot: false,
    metadataAdmission: false,
  };
  let current = instance;
  const real = createQueueInstance(
    path.resolve("src/queue-broker.js"),
    platform,
  );
  const facadeReceipt: BrokerModules["./queue-instance"]["prepareReceiptScript"] =
    real.prepareReceiptScript;
  const ports: {
    -readonly [
      K in keyof BrokerRpcPreparationPorts
    ]: BrokerRpcPreparationPorts[K];
  } = {
    buildHash: "runtime-build",
    nativeMcp: false,
    nativePaths: { mapPath: (file) => file },
    view: () => {
      trace.push("view");
      return { ...view };
    },
    runtimeInstance: () => {
      trace.push("instance");
      return current;
    },
    jobDirectory: (id) => path.join("/tmp/opencode/never-submitted-rpc", id),
    admitEpochRequest: () => {
      trace.push("epoch");
      return null;
    },
    verifyPreparedJob: (_job, epoch) => {
      trace.push("verify");
      if (epoch !== view.contextEpoch)
        throw Object.assign(new Error("epoch changed"), {
          code: "DOCUMENT_CHANGED",
        });
    },
    isolatedTool: () => {
      trace.push("isolated");
    },
    localPreparation: () => undefined,
    metadata: {
      job: () => undefined,
      program: () => assert.fail("unexpected metadata compilation"),
      assertDocumentMetadataRead: () =>
        assert.fail("unexpected metadata assertion"),
    },
    prepareBrokerScript,
    prepareReceiptScript: facadeReceipt,
    retainPythonOrigin: (artifact, origin) =>
      retainPythonOrigin(
        artifact,
        origin as unknown as Parameters<typeof retainPythonOrigin>[1],
      ),
    prepareMetadataWire,
    pythonAdmission: createPythonRpcAdmission({
      runtime,
      resources: () => "fixed-checker-resources",
      checker: {
        async check({ artifact }) {
          trace.push("checker");
          return report(artifact);
        },
      },
    }),
    localCheckOptions: () => ({}),
    testCheckPrepared: () => {
      trace.push("observer");
    },
  };
  return {
    ports,
    view,
    trace,
    setInstance(value: P.Instance) {
      current = value;
    },
    prepare(payload: P.Rpc, origin?: P.Origin, raw = false) {
      return createBrokerRpcPreparation(ports).prepareOwnedPost(
        payload,
        job,
        origin,
        raw,
      );
    },
  };
}

test("clones the full caller wire, allocates unique identity, and retains original provenance", async () => {
  const f = fixture();
  const caller: P.Rpc = {
    jsonrpc: "2.0",
    id: 1,
    method: "resources/list",
    params: { arguments: { untouched: [1, 2] } },
    extension: "retained",
  };
  const bytes = JSON.stringify(caller);
  const a = await f.prepare(caller),
    b = await f.prepare(caller);
  assert.equal(JSON.stringify(caller), bytes);
  assert.notEqual(a.rpcId, b.rpcId);
  assert.equal(a.outgoing.id, "fmcad:" + a.rpcId);
  assert.deepEqual({ ...a.outgoing, id: 1 }, caller);
  assert.deepEqual(a.record.binding, {
    jobId: job.id,
    rpcId: a.rpcId,
    requestHash: digest(bytes),
    buildHash: "runtime-build",
  });
  assert.deepEqual(a.record.request, {
    jsonrpc: "2.0",
    id: 1,
    method: caller.method,
  });
  assert.deepEqual(a.record.wireRequest, {
    jsonrpc: "2.0",
    id: a.outgoing.id,
    method: caller.method,
  });
  assert.equal(a.record.instance, instance);
  assert.equal(a.record.terminal, false);
  assert.equal(a.record.receipt, undefined);
  assert.equal(a.metadataOnly, false);
});

test("notification ID absence and metadata-only classification remain exact", async () => {
  for (const method of [
    "initialize",
    "notifications/initialized",
    "ping",
    "tools/list",
    "resources/list",
  ]) {
    const f = fixture();
    const result = await f.prepare({ jsonrpc: "2.0", method });
    for (const wire of [
      result.outgoing,
      result.record.request!,
      result.record.wireRequest!,
    ])
      assert.equal(Object.hasOwn(wire, "id"), false);
    assert.equal(result.metadataOnly, method !== "resources/list");
  }
  const result = await fixture().prepare({
    jsonrpc: "2.0",
    method: "ping",
    id: undefined,
  });
  assert.equal(Object.hasOwn(result.record.request!, "id"), true);
  assert.equal(result.record.request!.id, undefined);
  assert.equal(result.outgoing.id, "fmcad:" + result.rpcId);
});

test("actual script/receipt/artifact and admission services certify final bytes, never caller bytes", async () => {
  const f = fixture(),
    caller = python(),
    bytes = JSON.stringify(caller);
  const signal = new AbortController().signal;
  f.ports.localCheckOptions = () => ({ signal });
  const admission = f.ports.pythonAdmission;
  let receivedSignal: AbortSignal | undefined;
  f.ports.pythonAdmission = {
    check(wire, artifact, options) {
      receivedSignal = options?.signal;
      return admission.check(wire, artifact, options);
    },
  };
  const result = await f.prepare(caller);
  assert.ok(result.pythonArtifact);
  verifyPythonArtifact(result.pythonArtifact);
  assert.equal(
    result.record.binding.sourceHash,
    digest(caller.params!.arguments!.code!),
  );
  assert.equal(
    result.record.receipt,
    path.join(f.ports.jobDirectory(job.id), `remote-${result.rpcId}.json`),
  );
  assert.equal(
    result.outgoing.params!.arguments!.code,
    result.pythonArtifact.script,
  );
  assert.deepEqual(result.outgoing.params!.arguments!["extra"], {
    retained: true,
  });
  assert.equal(
    result.record.pythonArtifact!.artifactHash,
    result.pythonArtifact.artifactHash,
  );
  assert.equal(
    result.record.pythonCheck!.provenance.wireHash,
    result.pythonArtifact.sha256,
  );
  assert.equal(result.record.dispatchClass, "python");
  assert.equal(receivedSignal, signal);
  assert.equal(JSON.stringify(caller), bytes);
  assert.deepEqual(f.trace, [
    "view",
    "instance",
    "isolated",
    "checker",
    "observer",
    "verify",
  ]);
  result.pythonCertificate.fence(result.outgoing);
});

test("native public Python wrapping and origin retain the existing artifact pipeline", async () => {
  const f = fixture();
  f.ports.nativeMcp = true;
  const source = "answer: int = 42";
  const original = prepareWireArtifact(runtime, source);
  const result = await f.prepare(
    python(source),
    pythonArtifactManifest(original) as unknown as P.Origin,
  );
  assert.equal(result.outgoing.params!.name, "fusion_mcp_execute");
  assert.equal(result.outgoing.params!.arguments!.featureType, "script");
  assert.equal(result.outgoing.params!.arguments!.object!.readOnly, false);
  assert.equal(
    result.record.binding["publicPythonResultSchema"],
    "fmcad-public-python-result-v1",
  );
  assert.ok(result.pythonArtifact);
  verifyPythonArtifact(result.pythonArtifact);
  assert.equal(
    result.outgoing.params!.arguments!.object!.script,
    result.pythonArtifact.script,
  );
  assert.ok(
    result.pythonArtifact.units.some((unit) => unit.source.includes(source)),
  );
});

test("epoch and saved-first-save policies retain exact audit binding; normal mode omits isolation", async () => {
  for (const mode of ["isolated", "normal-multidocument"]) {
    const f = fixture();
    f.view.epoch = {
      epochId: "epoch",
      root: "/root",
      document: { name: "fixture", creationId: "created", fileId: null },
      currentInstance: instance,
      originalInstance: instance,
      ownerClientId: "owner",
      ownerTokenHash: "hash",
    };
    f.view.admissionMode = mode;
    f.ports.admitEpochRequest = (request) => {
      assert.equal(request, job.request);
      return { kind: "saved-first-save", purpose: "save" };
    };
    const result = await f.prepare({ jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(result.record.binding["auditFirstSave"], true);
    assert.equal(result.record.binding["purpose"], "save");
    assert.equal(
      result.record.binding["isolatedEpoch"],
      mode === "isolated" ? "epoch" : undefined,
    );
    if (mode === "isolated") {
      assert.equal(
        result.record.binding["qualifiedDocumentHash"],
        digest(JSON.stringify(f.view.epoch.document)),
      );
      assert.equal(result.record.binding["auditExpectedInstance"], instance);
      assert.equal(
        result.record.binding["auditExpectedDocument"],
        f.view.epoch.document,
      );
    }
  }
});

test("runtime-root user requests require admission but broker startup metadata does not", async () => {
  const f = fixture();
  f.view.approvedRuntimeRoot = true;
  await createBrokerRpcPreparation(f.ports).prepareOwnedPost(
    { jsonrpc: "2.0", method: "initialize" },
    { id: "startup" },
  );
  assert.equal(f.trace.includes("epoch"), false);
  await f.prepare({ jsonrpc: "2.0", method: "ping" });
  assert.equal(f.trace.includes("epoch"), true);
});

test("runtime/current pins are read independently before asynchronous checking; final verify stays last", async () => {
  const f = fixture();
  const realCheck = f.ports.pythonAdmission.check;
  f.ports.pythonAdmission = {
    async check(...args) {
      f.setInstance(otherInstance);
      f.view.contextEpoch = 8;
      return realCheck(...args);
    },
  };
  let observed: P.PreparedCall | undefined;
  f.ports.testCheckPrepared = (prepared) => {
    observed = prepared;
  };
  await assert.rejects(f.prepare(python()), { code: "DOCUMENT_CHANGED" });
  assert.ok(observed);
  assert.equal(observed.contextEpoch, 7);
  assert.equal(observed.record.instance, instance);
  assert.equal(f.trace.at(-1), "verify");
});

test("test observer cannot replace checking or mutate certified wire before the final fence", async () => {
  const f = fixture();
  f.ports.testCheckPrepared = (prepared) => {
    prepared.outgoing["tamper"] = true;
  };
  await assert.rejects(f.prepare(python()), {
    code: "PYTHON_ADMISSION_CHANGED",
  });
  assert.equal(f.trace.includes("checker"), true);
  assert.equal(f.trace.includes("verify"), false);
  const refused = fixture(),
    cause = new Error("checker refused");
  refused.ports.pythonAdmission = {
    check: async () => {
      throw cause;
    },
  };
  await assert.rejects(refused.prepare(python()), (error) => error === cause);
  assert.equal(refused.trace.includes("observer"), false);
  assert.equal(refused.trace.includes("verify"), false);
});

test("raw metadata uses its actual capability proof without Python checking or observer", async () => {
  const f = fixture();
  const caller: P.Rpc = {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "get_open_document_metadata",
      arguments: { fileId: "saved-file", version: 4 },
    },
  };
  await assert.rejects(f.prepare(caller, undefined, true), {
    code: "unsupported_queue_route",
  });
  f.view.metadataAdmission = true;
  const result = await f.prepare(caller, undefined, true);
  assert.ok(result.metadataProof);
  assert.equal(result.pythonCertificate, undefined);
  assert.equal(result.record.dispatchClass, "addin-metadata");
  assert.equal(result.outgoing.id, "fmcad:" + result.rpcId);
  assert.equal(Object.isFrozen(result.outgoing), true);
  assert.equal(f.trace.includes("checker"), false);
  assert.equal(f.trace.includes("observer"), false);
  result.metadataProof.fence(result.outgoing);
  assert.throws(
    () => result.metadataProof.fence({ ...result.outgoing, id: "other" }),
    { code: "INPUT_CHANGED" },
  );
  const invalid = structuredClone(caller);
  invalid.params!.arguments!["extra"] = "forged";
  await assert.rejects(f.prepare(invalid, undefined, true), {
    code: "INVALID_RPC",
  });
});

test("compiler source and all compiled-scope bindings precede check and receipt wrapping", async () => {
  const source = "answer: int = 42";
  const metadataJob = {
    ...job,
    hash: "request-hash",
    documentMetadataRead: { rpcHash: "rpc-hash" },
  } as P.Job;
  const valid = {
    producer: "compiled-document-metadata-v1",
    requestHash: metadataJob.hash,
    programHash: digest(source),
    rpcHash: "rpc-hash",
  };
  for (const field of [
    undefined,
    "producer",
    "requestHash",
    "programHash",
    "rpcHash",
    "missing-scope",
    "other-job",
  ] as const) {
    const f = fixture();
    const scope = { ...valid };
    if (field && field !== "missing-scope" && field !== "other-job")
      scope[field] = "forged";
    f.ports.localPreparation = () =>
      field === "missing-scope"
        ? undefined
        : {
            job: field === "other-job" ? { id: "other" } : job,
            compiledScope: scope,
          };
    f.ports.metadata = {
      job: () => metadataJob,
      program: (current) => {
        assert.equal(current, metadataJob);
        return {
          assertProgram(request, actual) {
            f.trace.push("compiler");
            assert.equal(request, job.request);
            assert.equal(actual, source);
          },
        };
      },
      assertDocumentMetadataRead(id, programHash, rpcHash) {
        f.trace.push("metadata");
        assert.equal(id, job.id);
        assert.equal(programHash, digest(source));
        assert.equal(rpcHash, "rpc-hash");
      },
    };
    if (field) {
      await assert.rejects(f.prepare(python(source)), {
        code: "DOCUMENT_METADATA_READ_UNPROVEN",
      });
      assert.equal(f.trace.includes("checker"), false);
      assert.equal(f.trace.includes("metadata"), false);
    } else {
      const result = await f.prepare(python(source));
      assert.deepEqual(result.record.binding["documentScope"], {
        ...valid,
        wireSourceHash: digest(source),
      });
      assert.ok(f.trace.indexOf("compiler") < f.trace.indexOf("metadata"));
      assert.ok(f.trace.indexOf("metadata") < f.trace.indexOf("checker"));
    }
  }
});

test("source compiler rejection and tool argument guards cannot be bypassed by an observer", async () => {
  const f = fixture(),
    cause = new Error("compiler source mismatch");
  const metadataJob = {
    ...job,
    documentMetadataRead: { rpcHash: "rpc" },
  } as P.Job;
  f.ports.metadata = {
    job: () => metadataJob,
    program: () => ({
      assertProgram() {
        throw cause;
      },
    }),
    assertDocumentMetadataRead: () => assert.fail("not reached"),
  };
  await assert.rejects(f.prepare(python()), (error) => error === cause);
  assert.equal(f.trace.includes("observer"), false);
  const g = fixture(),
    invalid = python();
  invalid.params!.arguments!.persistent = true;
  await assert.rejects(g.prepare(invalid), { code: "unsupported_queue_route" });
  assert.equal(g.trace.includes("checker"), false);
});

test("the canonical prepared-turn instance consumes module output once without another executor", async () => {
  const f = fixture(),
    turn = createTurnIdentity(job.id);
  const prepared = await prepare(turn, () =>
    f.prepare({ jsonrpc: "2.0", id: 1, method: "ping" }),
  );
  let calls = 0;
  const grant = { turn };
  const ports = {
    assertCurrentGrant: () => undefined,
    fence(ready: P.PreparedCall) {
      (ready.metadataProof ?? ready.pythonCertificate).fence(ready.outgoing);
      return undefined;
    },
    async check() {},
    async admit(send: () => Promise<P.PreparedCall>) {
      return send();
    },
    async send(ready: P.PreparedCall) {
      calls++;
      return ready;
    },
    settle(_ready: P.PreparedCall, reply: P.PreparedCall) {
      return reply;
    },
    unknown() {
      assert.fail("unexpected unknown");
    },
  };
  await executeTurn(grant, prepared, ports);
  await assert.rejects(executeTurn(grant, prepared, ports), {
    code: "PREPARED_RPC_CONSUMED",
  });
  assert.equal(calls, 1);
});

test("the actual offline checker analyzes the generated receipt wire before observation", async () => {
  const f = fixture();
  f.ports.pythonAdmission = createPythonRpcAdmission({
    runtime,
    checker: createPythonChecker({
      typingRoot: path.join(runtime, "typing"),
      definitionsRoot: path.join(runtime, "typing"),
      pythonPlatform: "Windows",
    }),
  });
  const result = await f.prepare(python());
  assert.equal(result.record.pythonCheck?.status, "passed");
  assert.equal(result.record.pythonCheck?.provenance.checker, "basedpyright");
  assert.equal(
    result.record.pythonCheck?.provenance.wireHash,
    result.pythonArtifact?.sha256,
  );
  assert.ok(result.pythonCertificate);
  result.pythonCertificate.fence(result.outgoing);
  assert.equal(f.trace.at(-1), "verify");
});

test("the actual offline checker rejects an invalid caller program before observer and final publication", async () => {
  const f = fixture();
  f.ports.pythonAdmission = createPythonRpcAdmission({
    runtime,
    checker: createPythonChecker({
      typingRoot: path.join(runtime, "typing"),
      definitionsRoot: path.join(runtime, "typing"),
      pythonPlatform: "Windows",
    }),
  });
  await assert.rejects(
    f.prepare(python('answer: int = "invalid"')),
    (error: unknown) => {
      assert.ok(
        error &&
          typeof error === "object" &&
          "code" in error &&
          "pythonCheck" in error,
      );
      assert.equal(error.code, "PYTHON_CHECK_REJECTED");
      const report = error.pythonCheck as PythonCheckReport;
      assert.equal(report.status, "failed");
      assert.ok(
        report.diagnostics.some((item) => item.rule === "reportAssignmentType"),
      );
      return true;
    },
  );
  assert.equal(f.trace.includes("observer"), false);
  assert.equal(f.trace.includes("verify"), false);
});
