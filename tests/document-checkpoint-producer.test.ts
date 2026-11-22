import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { QueueJob } from "../packages/core/src/domain/queue-model";
import { hash as canonicalHash } from "../packages/core/src/application/cad/json";
import { planCadScript } from "../packages/core/src/application/cad/prepare";
import { decodeDocumentCheckpointReadback } from "../src/document-checkpoint-readback";
import {
  preparePythonArtifact,
  pythonLiteral,
} from "../packages/node-adapters/src/python/artifact";
import { pythonArtifactManifest } from "../packages/node-adapters/src/python/context-binding";
import { prepareBrokerScript } from "../packages/node-adapters/src/execution/broker-preparation";
import {
  createBrokerRecords,
  type RpcRecord,
  type RemoteReceipt,
} from "../packages/node-adapters/src/persistence/broker-records";
import {
  createDocumentObservationStore,
  type ObservationArtifact,
  type ObservationProof,
} from "../packages/node-adapters/src/execution/document-observation-store";
import {
  createDocumentCheckpointProducer,
  type CheckpointProducerPorts,
  type CheckpointRpc,
} from "../packages/node-adapters/src/execution/document-checkpoint-producer";

const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const copy = <T>(value: T): T => structuredClone(value);
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-producer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobDirectory = path.join(root, "jobs", "read-job");
  fs.mkdirSync(path.dirname(jobDirectory), { mode: 0o700 });
  fs.mkdirSync(jobDirectory, { mode: 0o700 });
  const target = { creationId: "doc-A", fileId: "file-A" };
  const generation = "generation-at-probe-start";
  const buildHash = sha256("pinned-runtime-build");
  const job: QueueJob = {
    id: "read-job",
    clientId: "reader-A",
    requestId: "probe-A",
    kind: "command",
    hash: sha256("original-owned-job"),
    request: {
      clientId: "reader-A",
      requestId: "probe-A",
      kind: "command",
      argv: [
        "cad",
        "param",
        "inspect",
        "--doc-id",
        "doc-A",
        "--doc-file-id",
        "file-A",
      ],
      timeoutMs: 10000,
      cwd: root,
      buildHash,
    },
    order: 1,
    state: "running",
    submittedAt: 100,
    timeoutMs: 10000,
    queueDeadline: null,
    sequenceId: null,
    sequenceState: null,
    documentInspection: {
      version: 1,
      target,
      generation,
      blockersDigest: sha256("old-UNKNOWN-blocker"),
      priorCheckpointId: null,
    },
  };
  const physicalTurn = {
    version: 1 as const,
    generation: { epoch: "native-epoch-A", instance: "native-instance-A" },
    grantDigest: sha256("native-grant"),
    target: JSON.stringify(target),
    turnId: "rpc-A",
    physicalRuntime: {
      pid: 123,
      birth: "native-birth",
      version: "fork-v1",
      source: sha256("fork-source"),
      build: sha256("fork-build"),
    },
  };
  const instance = { pid: 123, birth: "native-birth", version: "Fusion-v1" };
  const receiptPath = path.join(jobDirectory, "remote-rpc-A.json");
  const compile = () => {
    // Actual shared compiler plan and private callback, not a caller-supplied
    // source hash or a handwritten replacement for the production compiler.
    const plan = planCadScript(
      "param.inspect",
      { includeModel: true },
      { docId: target.creationId, docFileId: target.fileId },
      {
        summary: "Inspect parameters",
        inputs: {},
        required: [],
        example: {},
        limitations: [],
        readOnly: true,
      },
      pythonLiteral,
      "param-checkpoint",
    );
    return preparePythonArtifact(
      [
        {
          id: "checkpoint-plan",
          filename: "<checkpoint-plan>",
          role: "wrapper",
          source: plan.wrapper,
        },
      ],
      { request: plan.request, context: plan.context },
    );
  };
  const compiled = compile();
  // Model the actual source distinction: transport adds its entrypoint before
  // the existing receipt preparation stage binds sourceHash.
  const payload: CheckpointRpc = {
    jsonrpc: "2.0",
    method: "tools/call",
    id: 2,
    params: {
      name: "execute_python",
      arguments: {
        code: compiled.script + '\nrun("")\n',
        persistent: false,
      },
    },
  };
  const binding = {
    jobId: job.id,
    rpcId: "rpc-A",
    requestHash: sha256(JSON.stringify(payload)),
    buildHash,
    sourceHash: sha256(payload.params.arguments.code),
    physicalTurn,
    documentScope: {
      producer: "compiled-cad-v1",
      operation: "param.inspect",
      sourceHash: compiled.sha256,
      wireSourceHash: sha256(payload.params.arguments.code),
      buildHash,
      target,
    },
  };
  function prepared(record: RpcRecord) {
    const original = copy(payload);
    const wire = copy(original);
    const wrapped = prepareBrokerScript(wire, {
      nativeMcp: false,
      bindSource(source) {
        assert.equal(sha256(source), binding.sourceHash);
      },
      wrap(source) {
        // Offline receipt wrapper fixture; Windows/native execution is NOTRUN.
        return preparePythonArtifact(
          [
            {
              id: "receipt",
              filename: "<fixture-receipt>",
              role: "wrapper",
              source: `# receipt ${JSON.stringify(record.binding)}\n${source}`,
            },
          ],
          { request: record.binding },
        );
      },
    })!;
    wire.id = `fmcad:${record.binding.rpcId}`;
    return { compiled: compile(), wrapped, payload: original, wire };
  }
  const record: RpcRecord & { pythonArtifact?: unknown } = {
    binding,
    method: "tools/call",
    terminal: false,
    instance,
    receipt: receiptPath,
    request: { jsonrpc: "2.0", method: "tools/call", id: 2 },
    wireRequest: { jsonrpc: "2.0", method: "tools/call", id: "fmcad:rpc-A" },
  };
  const expected = prepared(record);
  record.pythonArtifact = {
    version: expected.wrapped.version,
    sha256: expected.wrapped.sha256,
    artifactHash: expected.wrapped.artifactHash,
    sourceMap: expected.wrapped.sourceMap,
    units: expected.wrapped.units.map(({ id, filename, role, sha256 }) => ({
      id,
      filename,
      role,
      sha256,
    })),
  };
  const checkpoint = {
    schema: "fmcad.param-checkpoint-v1",
    document: {
      identity: {
        ...target,
        name: "Owned A",
        version: 1,
        isSaved: true,
        isModified: false,
      },
      fingerprint: sha256("actual-observed-document"),
    },
    parameters: [
      {
        name: "length",
        expression: "10 mm",
        unit: "mm",
        value: 1,
        valueType: "numeric",
        valueUnits: "Fusion internal units (cm, rad, kg, s)",
        comment: "",
        metadata: { dependency: "model-and-user", finite: 1 },
      },
      {
        name: "label",
        expression: '"hello"',
        unit: "text",
        value: "hello",
        valueType: "text",
        valueUnits: null,
        comment: "",
        metadata: {},
      },
    ],
  };
  const nativeResult = {
    success: true,
    operation: "param.inspect",
    result: checkpoint,
    created: [],
  };
  const response = {
    status: 200,
    raw: JSON.stringify({
      jsonrpc: "2.0",
      id: "fmcad:rpc-A",
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              stdout: "FMCAD_RESULT " + JSON.stringify(nativeResult),
              stderr: "",
            }),
          },
        ],
      },
    }),
  };
  const records = createBrokerRecords(root);
  records.createIntent(job.id, {
    id: job.id,
    request: job.request,
    buildHash,
    properties: {},
    deadline: 10000,
  });
  records.createRpcIntent(job.id, record);
  records.recordReceivedResponse(job.id, {
    version: 1,
    kind: "owned-rpc-received-response-v1",
    binding,
    wireId: record.wireRequest!.id,
    response,
  });
  const receipt: RemoteReceipt = {
    ...binding,
    instance,
    terminal: true,
    outcome: "succeeded",
  };
  fs.writeFileSync(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  Object.assign(record, { terminal: true, response, remoteReceipt: receipt });
  records.recordRpcTerminal(job.id, record);
  const physicalBody = {
    request: {
      kind: "product" as const,
      brokerNonce: "broker-owned",
      jobId: job.id,
      requestId: job.requestId,
      clientId: job.clientId,
      requestHash: job.hash,
      grantGeneration: 1,
      physicalRequestId: physicalTurn.turnId,
      documentSelector: target,
    },
    physical: physicalTurn,
    target,
    catalogIndex: 1,
  };
  const intentReference = `physical-turn-${sha256(physicalTurn.turnId)}.json`;
  fs.writeFileSync(
    path.join(jobDirectory, intentReference),
    JSON.stringify(physicalBody),
    { mode: 0o600 },
  );
  job.physicalDispatches = [
    {
      ...physicalBody,
      intentReference,
      intentDigest: sha256(JSON.stringify(physicalBody)),
    },
  ];
  job.physicalDispatchCount = 1;
  // Actual HMAC boundary for offline fixtures, NOT a Windows/native grant,
  // production receipt or simulation claimed as an actual SDK response.
  const nativeKey = randomBytes(32);
  const nativeFile = path.join(jobDirectory, "native-proof.json");
  const nativeBody = () => {
    const current = records.evidence.readRpcRecords(job.id)[0]!;
    return {
      generation,
      physicalTurn: current.binding["physicalTurn"],
      receipt: records.evidence.readRemoteReceipt(current),
      actor: job.clientId,
      jobId: job.id,
      probeRequestId: job.requestId,
      target: job.documentInspection!.target,
      responseHash: sha256(current.response!.raw),
    };
  };
  function sealNative() {
    const body = nativeBody();
    const mac = createHmac("sha256", nativeKey)
      .update(JSON.stringify(body))
      .digest("hex");
    fs.writeFileSync(nativeFile, JSON.stringify({ body, mac }), {
      mode: 0o600,
    });
  }
  sealNative();
  const ports: CheckpointProducerPorts = {
    buildHash,
    records: records.evidence,
    readJob() {
      return copy(job);
    },
    prepareExpectedProgram({ record }) {
      return prepared(record);
    },
    matchResponse(rpc) {
      assert.ok(rpc.response!.status >= 200 && rpc.response!.status < 300);
      const value = JSON.parse(rpc.response!.raw) as Record<string, unknown>;
      assert.equal(value["jsonrpc"], "2.0");
      assert.equal(value["id"], rpc.wireRequest!.id);
      return value;
    },
    verifyNativeRead({
      job: actualJob,
      record: actualRecord,
      intent,
      receipt: actualReceipt,
      artifacts,
    }) {
      const value = artifacts.find((a) => a.role === "native-proof")!.value as {
        body: ReturnType<typeof nativeBody>;
        mac: string;
      };
      const actual = createHmac("sha256", nativeKey)
        .update(JSON.stringify(value.body))
        .digest();
      assert.equal(
        timingSafeEqual(actual, Buffer.from(value.mac, "hex")),
        true,
      );
      assert.deepEqual(value.body, {
        generation,
        physicalTurn: intent.physical,
        receipt: actualReceipt,
        actor: actualJob.clientId,
        jobId: actualJob.id,
        probeRequestId: actualJob.requestId,
        target: actualJob.documentInspection!.target,
        responseHash: sha256(actualRecord.response!.raw),
      });
      return {
        generation: value.body.generation,
        physicalTurn: copy(intent.physical),
        receipt: copy(value.body.receipt),
      };
    },
    decodeReadback: decodeDocumentCheckpointReadback,
  };
  const proof: ObservationProof = {
    jobId: job.id,
    rpcId: binding.rpcId,
    probeRequestId: job.requestId,
    requestHash: binding.requestHash,
    buildHash,
    sourceHash: compiled.sha256,
    producerManifestHash: canonicalHash(pythonArtifactManifest(compiled)),
    physicalTurn: copy(physicalTurn),
    artifacts: [],
  };
  const roleNames: Record<string, string> = {
    rpc: "rpc-rpc-A.json",
    response: "received-response-rpc-A.json",
    "physical-intent": intentReference,
    "remote-receipt": "remote-rpc-A.json",
    "native-proof": "native-proof.json",
  };
  const context = {
    id: "observation-A",
    requestId: "external-inspection-request",
    actorClientId: job.clientId,
    target: copy(target),
    generation,
    scope: "parameters" as const,
    stateDigest: canonicalHash(checkpoint),
  };
  function input() {
    const artifacts: ObservationArtifact[] = Object.entries(roleNames).map(
      ([role, name]) => {
        const bytes = fs.readFileSync(path.join(jobDirectory, name));
        return {
          role,
          reference: `jobs/${job.id}/${name}`,
          sha256: sha256(bytes),
          bytes,
          value: JSON.parse(bytes.toString("utf8")) as unknown,
        };
      },
    );
    proof.artifacts = artifacts.map(
      ({ bytes: _bytes, value: _value, ...source }) => {
        void _bytes;
        void _value;
        return source;
      },
    );
    return { context: copy(context), proof: copy(proof), artifacts };
  }
  function mutate(role: string, fn: (value: Record<string, unknown>) => void) {
    const file = path.join(jobDirectory, roleNames[role]!);
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    fn(value);
    fs.writeFileSync(file, JSON.stringify(value));
  }
  function mutateReply(fn: (reply: Record<string, unknown>) => void) {
    const current = records.evidence.readRpcRecords(job.id)[0]!;
    const reply = JSON.parse(current.response!.raw) as Record<string, unknown>;
    fn(reply);
    const raw = JSON.stringify(reply);
    mutate("rpc", (r) => {
      (r["response"] as { raw: string }).raw = raw;
    });
    mutate("response", (r) => {
      (r["response"] as { raw: string }).raw = raw;
    });
    sealNative();
  }
  return {
    root,
    jobDirectory,
    job,
    ports,
    proof,
    context,
    input,
    mutate,
    mutateReply,
    sealNative,
    record,
    checkpoint,
    nativeResult,
    roleNames,
  };
}

test("actual broker-records originals and authenticated fixture produce a complete source-bound read", (t) => {
  const f = fixture(t);
  const verify = createDocumentCheckpointProducer(f.ports);
  const input = f.input();
  assert.notEqual(
    input.proof.sourceHash,
    f.record.binding.sourceHash,
    "compiled and pre-wrapper source namespaces must remain distinct",
  );
  const result = verify(input);
  assert.deepEqual(result, {
    actorClientId: f.job.clientId,
    target: f.context.target,
    generation: f.context.generation,
    stateDigest: canonicalHash(f.checkpoint),
    probeRequestId: f.job.requestId,
    proof: input.proof,
  });
  assert.equal(
    f.job.state,
    "running",
    "successful RPC is not whole-job completion",
  );
});

test("verified producer integrates with immutable observation publication and fresh restore", (t) => {
  const f = fixture(t);
  const options = {
    directory: f.root,
    namespace: "queue-checkpoint-fixture",
    verifyProducer: createDocumentCheckpointProducer(f.ports),
  };
  const store = createDocumentObservationStore(options),
    input = f.input();
  const readback = store.persist(input.context, input.proof);
  createDocumentObservationStore(options).verify({
    ...input.context,
    readback,
  });
  assert.equal(readback.probeRequestId, f.job.requestId);
});

for (const name of [
  "matchResponse",
  "verifyNativeRead",
  "decodeReadback",
  "prepareExpectedProgram",
] as const) {
  test(`missing required ${name} port is not a permissive proof`, (t) => {
    const f = fixture(t);
    const ports = { ...f.ports, [name]: undefined };
    assert.throws(() =>
      createDocumentCheckpointProducer(
        ports as unknown as CheckpointProducerPorts,
      ),
    );
  });
}

for (const field of [
  "actorClientId",
  "target",
  "generation",
  "stateDigest",
] as const) {
  test(`caller-asserted ${field} cannot replace derived response proof`, (t) => {
    const f = fixture(t),
      input = f.input();
    if (field === "target")
      input.context.target = { creationId: "B", fileId: "B" };
    else input.context[field] = "forged";
    assert.throws(() => createDocumentCheckpointProducer(f.ports)(input));
  });
}

for (const field of [
  "probeRequestId",
  "sourceHash",
  "producerManifestHash",
  "buildHash",
  "requestHash",
] as const) {
  test(`foreign proof ${field} is rejected despite rehashed source artifacts`, (t) => {
    const f = fixture(t),
      input = f.input();
    input.proof[field] =
      field === "probeRequestId" ? "other-probe" : sha256("forged");
    assert.throws(() => createDocumentCheckpointProducer(f.ports)(input));
  });
}

for (const field of [
  "terminal",
  "failed",
  "nonterminal",
  "sourceHash",
  "buildHash",
  "pythonArtifact",
  "request",
  "physicalTurn",
]) {
  test(`rewritten original RPC ${field} does not pass on new JSON hashes`, (t) => {
    const f = fixture(t);
    f.mutate("rpc", (r) => {
      const binding = r["binding"] as Record<string, unknown>;
      if (field === "terminal") r[field] = false;
      else if (field === "failed" || field === "nonterminal") r[field] = true;
      else if (field === "sourceHash" || field === "buildHash")
        binding[field] = sha256("forged");
      else if (field === "physicalTurn")
        binding[field] = {
          ...f.proof.physicalTurn,
          grantDigest: sha256("foreign"),
        };
      else r[field] = {};
    });
    assert.throws(() => createDocumentCheckpointProducer(f.ports)(f.input()));
  });
}

test("coherently rewritten scope and manifest still cannot replace the pinned compiler", (t) => {
  const f = fixture(t);
  f.mutate("rpc", (r) => {
    const binding = r["binding"] as Record<string, unknown>;
    (binding["documentScope"] as Record<string, unknown>)["sourceHash"] =
      sha256("foreign-source");
    (r["pythonArtifact"] as Record<string, unknown>)["artifactHash"] =
      sha256("foreign-manifest");
  });
  const rpc = JSON.parse(
    fs.readFileSync(path.join(f.jobDirectory, "rpc-rpc-A.json"), "utf8"),
  ) as RpcRecord;
  f.mutate("response", (r) => {
    r["binding"] = rpc.binding;
  });
  f.mutate("remote-receipt", (r) => {
    Object.assign(r, rpc.binding);
  });
  f.sealNative();
  const input = f.input();
  input.proof.sourceHash = sha256("foreign-source");
  assert.throws(() => createDocumentCheckpointProducer(f.ports)(input));
});

for (const kind of [
  "wrong-id",
  "http-error",
  "tool-error",
  "rpc-error",
  "failed-script",
  "ordinary-output",
  "duplicate-result",
  "wrong-operation",
  "wrong-target",
  "truncated",
]) {
  test(`original retained ${kind} response is not an authentic full checkpoint`, (t) => {
    const f = fixture(t);
    if (kind === "http-error") {
      for (const role of ["rpc", "response"])
        f.mutate(role, (r) => {
          (r["response"] as { status: number }).status = 503;
        });
      f.sealNative();
    } else
      f.mutateReply((reply) => {
        const result = reply["result"] as Record<string, unknown>;
        const content = result["content"] as { text: string }[];
        const payload = JSON.parse(content[0]!.text) as Record<string, unknown>;
        if (kind === "wrong-id") reply["id"] = "fmcad:foreign";
        if (kind === "tool-error") result["isError"] = true;
        if (kind === "rpc-error")
          reply["error"] = { code: -32000, message: "failed" };
        if (kind === "failed-script") payload["success"] = false;
        if (kind === "ordinary-output")
          payload["stdout"] =
            "FMCAD_RESULT " +
            JSON.stringify({ ...f.nativeResult, result: { parameters: [] } });
        if (kind === "duplicate-result")
          payload["stdout"] =
            String(payload["stdout"]) + "\n" + payload["stdout"];
        if (kind === "wrong-operation")
          payload["stdout"] =
            "FMCAD_RESULT " +
            JSON.stringify({ ...f.nativeResult, operation: "param.apply" });
        if (kind === "wrong-target") {
          const foreign = copy(f.nativeResult);
          foreign.result.document.identity.creationId = "B";
          payload["stdout"] = "FMCAD_RESULT " + JSON.stringify(foreign);
        }
        if (kind === "truncated")
          payload["stdout"] = 'FMCAD_RESULT {"success":';
        content[0]!.text = JSON.stringify(payload);
      });
    assert.throws(() => createDocumentCheckpointProducer(f.ports)(f.input()));
  });
}

test("altered reply without native provenance cannot be promoted by a matching wire id", (t) => {
  const f = fixture(t);
  for (const role of ["rpc", "response"])
    f.mutate(role, (r) => {
      const response = r["response"] as { raw: string };
      response.raw = response.raw.replace("Owned A", "forged-but-matching-id");
    });
  assert.throws(() => createDocumentCheckpointProducer(f.ports)(f.input()));
});

for (const kind of [
  "missing-receipt",
  "missing-native",
  "corrupt-native",
  "stale-native",
  "foreign-runtime",
]) {
  test(`${kind} is not substituted by JSON flags or rehashed bytes`, (t) => {
    const f = fixture(t);
    const retained = kind.startsWith("missing-") ? f.input() : undefined;
    if (kind === "missing-receipt")
      fs.unlinkSync(path.join(f.jobDirectory, f.roleNames["remote-receipt"]!));
    if (kind === "missing-native")
      fs.unlinkSync(path.join(f.jobDirectory, f.roleNames["native-proof"]!));
    if (kind === "missing-native" && retained) {
      retained.artifacts = retained.artifacts.filter(
        (a) => a.role !== "native-proof",
      );
      retained.proof.artifacts = retained.proof.artifacts.filter(
        (a) => a.role !== "native-proof",
      );
    }
    if (kind === "corrupt-native")
      f.mutate("native-proof", (p) => {
        p["mac"] = sha256("wrong");
      });
    if (kind === "stale-native")
      f.mutate("native-proof", (p) => {
        (p["body"] as Record<string, unknown>)["generation"] = "previous";
      });
    if (kind === "foreign-runtime")
      f.mutate("native-proof", (p) => {
        const body = p["body"] as {
          physicalTurn: { physicalRuntime: { pid: number } };
        };
        body.physicalTurn.physicalRuntime.pid = 999;
      });
    assert.throws(
      () => createDocumentCheckpointProducer(f.ports)(retained ?? f.input()),
      { code: "DOCUMENT_CHECKPOINT_PRODUCER_MISMATCH" },
    );
  });
}

test("a normal inspect without broker-authored inspection marker is refused", (t) => {
  const f = fixture(t);
  delete f.job.documentInspection;
  assert.throws(() => createDocumentCheckpointProducer(f.ports)(f.input()));
});

test("expected unfiltered private program cannot be replaced with a normal or filtered compiler artifact", (t) => {
  const f = fixture(t);
  const original = f.ports.prepareExpectedProgram;
  f.ports.prepareExpectedProgram = (input) => {
    const expected = original(input);
    const request = {
      ...(expected.compiled.request as object),
      data: { includeModel: true, names: ["one"] },
    };
    return {
      ...expected,
      compiled: preparePythonArtifact(
        [
          {
            id: "filtered",
            filename: "<filtered>",
            role: "wrapper",
            source: expected.compiled.script,
          },
        ],
        { request },
      ),
    };
  };
  const input = f.input();
  input.proof.sourceHash = f.ports.prepareExpectedProgram({
    job: f.job,
    record: f.record,
  }).compiled.sha256;
  assert.throws(() => createDocumentCheckpointProducer(f.ports)(input));
});

for (const kind of [
  "generation",
  "physicalTurn",
  "receipt",
  "boolean",
] as const) {
  test(`native verifier ${kind} mismatch is independently refused`, (t) => {
    const f = fixture(t);
    const original = f.ports.verifyNativeRead;
    f.ports.verifyNativeRead = (input) => {
      const value = original(input);
      if (kind === "generation")
        return { ...value, generation: "other-generation" };
      if (kind === "physicalTurn")
        return {
          ...value,
          physicalTurn: {
            ...value.physicalTurn,
            grantDigest: sha256("other-grant"),
          },
        };
      if (kind === "receipt")
        return {
          ...value,
          receipt: {
            ...value.receipt,
            sourceHash: sha256("other-source"),
          },
        };
      return true as unknown as typeof value;
    };
    assert.throws(() => createDocumentCheckpointProducer(f.ports)(f.input()), {
      code: "DOCUMENT_CHECKPOINT_PRODUCER_MISMATCH",
    });
  });
}

test("retained original response mismatch cannot be replaced by an independently matching RPC response", (t) => {
  const f = fixture(t);
  f.mutate("response", (value) => {
    (value["response"] as { raw: string }).raw = "{}";
  });
  assert.throws(() => createDocumentCheckpointProducer(f.ports)(f.input()), {
    code: "DOCUMENT_CHECKPOINT_PRODUCER_MISMATCH",
  });
});

test("a source artifact value detached from its actual bytes is rejected", (t) => {
  const f = fixture(t),
    input = f.input();
  input.artifacts[0]!.value = {};
  assert.throws(() => createDocumentCheckpointProducer(f.ports)(input), {
    code: "DOCUMENT_CHECKPOINT_PRODUCER_MISMATCH",
  });
});
