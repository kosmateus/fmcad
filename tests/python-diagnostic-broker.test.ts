import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  preparePythonDiagnostic,
  createPythonStdoutBroker,
  type StdoutCompilationPorts,
  type DiagnosticPreparationPorts,
} from "../src/python-diagnostic-broker";
import { QueueDomain } from "../packages/core/src/domain/queue";
import { preparePythonArtifact } from "../packages/node-adapters/src/python/artifact";
import { pythonArtifactManifest } from "../packages/node-adapters/src/python/context-binding";
import { prepareIsolatedStdout } from "../packages/node-adapters/src/python/isolated-stdout";

const sha = (source: string) =>
  createHash("sha256").update(source).digest("hex");
const kernelArtifact = (program: string, source: string) =>
  preparePythonArtifact([
    { id: "wire", filename: "wire.py", role: "wrapper", source: program },
    {
      id: "embedded:0",
      filename: "original.py",
      role: "user",
      source,
      embedded: true,
    },
  ]);

test("the broker accepts the actual approved kernel artifact without replacing the original source", async () => {
  const f = fixture();
  const source = 'print("original module output")\n';
  const request = {
    ...f.request,
    payload: {
      ...f.request.payload,
      params: {
        name: "execute_python",
        arguments: { code: source, persistent: false },
      },
    },
  };
  const kernel = prepareIsolatedStdout(source);
  assert.equal(kernel.status, "prepared");
  if (kernel.status !== "prepared") return;
  const prepared = await createPythonStdoutBroker().prepare(request, {
    recheck: f.ports.recheck,
    currentPins: f.ports.currentPins,
    verifyHostBindings: () => ({
      proofHash: sha("offline fixture host; not live evidence"),
      profileVersion: "isolated-stdout-v1",
    }),
    prepareKernel: prepareIsolatedStdout,
  });
  assert.ok(prepared);
  prepared.assertProgram(request, kernel.script);
  assert.equal(prepared.descriptor.sourceHash, sha(source));
  assert.equal(prepared.descriptor.programHash, kernel.programHash);
  assert.deepEqual(prepared.origin(), pythonArtifactManifest(kernel.artifact));
  assert.equal(request.payload.params.arguments.code, source);
});

test("compiled stdout binds the original input, private host and exact rewritten program without restoring registry witnesses", async () => {
  const f = fixture(),
    program = "# compiler-owned isolated stdout profile";
  let hostHash = sha("qualified private host");
  const ports: StdoutCompilationPorts = {
    recheck: f.ports.recheck,
    currentPins: f.ports.currentPins,
    verifyHostBindings: () => ({
      proofHash: hostHash,
      profileVersion: "isolated-stdout-v1",
    }),
    prepareKernel(source) {
      return {
        status: "prepared",
        sourceSha256: sha(source),
        programHash: sha(program),
        script: program,
        artifact: kernelArtifact(program, source),
        engineVersion: "python-source-effects-v2",
        profileVersion: "isolated-stdout-v1",
      };
    },
  };
  const broker = createPythonStdoutBroker(),
    prepared = await broker.prepare(f.request, ports);
  assert.ok(prepared);
  assert.deepEqual(
    prepared.origin(),
    pythonArtifactManifest(kernelArtifact(program, f.source)),
  );
  const badArtifactPorts: StdoutCompilationPorts = {
    ...ports,
    prepareKernel(source) {
      return {
        status: "prepared",
        sourceSha256: sha(source),
        programHash: sha(program),
        script: program,
        artifact: kernelArtifact(
          program,
          source + "\n# different embedded source",
        ),
        engineVersion: "python-source-effects-v2",
        profileVersion: "isolated-stdout-v1",
      };
    },
  };
  await assert.rejects(broker.prepare(f.request, badArtifactPorts), {
    code: "PYTHON_DIAGNOSTIC_UNPROVEN",
  });
  const state = new QueueDomain({
    now: () => 1000,
    newId: () => "prepared",
    hash: sha,
  });
  const authority = state.createPythonStdoutAuthority(() => {
    prepared.reverify(f.request);
    return prepared.descriptor;
  });
  const result = state.submitPythonStdout(f.request, authority);
  const job = state.data.jobs[String(result["id"])];
  assert.ok(job);
  broker.admit(job, prepared);
  const wire = prepared.rpc();
  wire["id"] = "fmcad:actual-rpc";
  prepared.assertWire(f.request, wire, "actual-rpc");
  prepared.assertProgram(f.request, program);
  assert.equal(f.request.payload.params.arguments.code, f.source);
  const copied = prepared.rpc();
  assert.ok(
    copied["params"] &&
      typeof copied["params"] === "object" &&
      !Array.isArray(copied["params"]),
  );
  copied["method"] = "ping";
  assert.throws(() => prepared.assertWire(f.request, copied, "actual-rpc"), {
    code: "PYTHON_DIAGNOSTIC_UNPROVEN",
  });
  assert.throws(() => broker.admit(job, { ...prepared }), {
    code: "PYTHON_DIAGNOSTIC_UNPROVEN",
  });
  assert.throws(() => createPythonStdoutBroker().program(job), {
    code: "PYTHON_DIAGNOSTIC_UNPROVEN",
  });
  hostHash = sha("different qualified host");
  assert.throws(() => broker.program(job), {
    code: "PYTHON_DIAGNOSTIC_UNPROVEN",
  });
});
test("stdout preparation refuses stale host after awaited compilation and accepts an unpinned public caller only under broker pins", async () => {
  const f = fixture(),
    program = "# compiler profile";
  let hostHash = sha("first host");
  const ports: StdoutCompilationPorts = {
    currentPins: f.ports.currentPins,
    recheck: f.ports.recheck,
    verifyHostBindings: () => ({
      proofHash: hostHash,
      profileVersion: "isolated-stdout-v1",
    }),
    async prepareKernel(source) {
      hostHash = sha("changed host during await");
      return {
        status: "prepared",
        sourceSha256: sha(source),
        programHash: sha(program),
        script: program,
        artifact: kernelArtifact(program, source),
        engineVersion: "python-source-effects-v2",
        profileVersion: "isolated-stdout-v1",
      };
    },
  };
  await assert.rejects(createPythonStdoutBroker().prepare(f.request, ports), {
    code: "PYTHON_DIAGNOSTIC_UNPROVEN",
  });
  const { buildHash, ...publicRequest } = f.request;
  void buildHash;
  const prepared = await createPythonStdoutBroker().prepare(publicRequest, {
    ...ports,
    prepareKernel(source) {
      return {
        status: "prepared",
        sourceSha256: sha(source),
        programHash: sha(program),
        script: program,
        artifact: kernelArtifact(program, source),
        engineVersion: "python-source-effects-v2",
        profileVersion: "isolated-stdout-v1",
      };
    },
  });
  assert.ok(prepared);
  assert.throws(
    () => prepared.reverify({ ...publicRequest, buildHash: "f".repeat(64) }),
    { code: "PYTHON_DIAGNOSTIC_UNPROVEN" },
  );
});
function fixture() {
  let generation = "original-generation",
    registered = true;
  const source = 'def run(_context):\n    print("marker")\n';
  const request = {
    kind: "rpc" as const,
    backend: "addin",
    clientId: "diagnostic-owner",
    requestId: "original-diagnostic",
    ownerToken: "a".repeat(64),
    buildHash: "b".repeat(64),
    timeoutMs: 45000,
    payload: {
      jsonrpc: "2.0",
      id: "original-rpc",
      method: "tools/call",
      params: {
        name: "execute_python",
        arguments: { code: source, persistent: false },
      },
    },
  };
  const ports: DiagnosticPreparationPorts = {
    engineVersion: "fixture-effects-v1",
    analyze(actual) {
      assert.equal(actual, source);
      return {
        status: "proven",
        engineVersion: "fixture-effects-v1",
        sourceSha256: sha(actual),
        effect: "stdout-and-readonly-metadata",
      };
    },
    recheck() {
      if (!registered)
        throw Object.assign(new Error("Revoked"), { code: "NOT_AUTHORIZED" });
    },
    currentPins: () => ({
      buildHash: request.buildHash,
      configHash: "c".repeat(64),
      generation,
    }),
  };
  return {
    source,
    request,
    ports,
    revoke() {
      registered = false;
    },
    changeGeneration() {
      generation = "changed-generation";
    },
  };
}
test("diagnostic preparation binds complete request, exact original source and current principal without granting execution", async () => {
  const f = fixture(),
    prepared = await preparePythonDiagnostic(f.request, f.ports);
  assert.ok(prepared);
  assert.equal(prepared.descriptor.sourceHash, sha(f.source));
  assert.equal(prepared.descriptor.engineVersion, f.ports.engineVersion);
  assert.equal("submit" in prepared, false);
  assert.equal("send" in prepared, false);
  prepared.assertSource(f.request, f.source);
  prepared.assertRpc(f.request, structuredClone(f.request.payload));
  assert.throws(() => prepared.assertSource(f.request, f.source + "\n"), {
    code: "PYTHON_DIAGNOSTIC_UNPROVEN",
  });
  assert.throws(() => prepared.reverify({ ...f.request, requestId: "other" }), {
    code: "PYTHON_DIAGNOSTIC_UNPROVEN",
  });
  assert.throws(
    () =>
      prepared.assertRpc(f.request, { ...f.request.payload, id: "other-rpc" }),
    { code: "PYTHON_DIAGNOSTIC_UNPROVEN" },
  );
  f.revoke();
  assert.throws(() => prepared.reverify(f.request), { code: "NOT_AUTHORIZED" });
});
test("caller readOnly and a producer's mismatched engine or source never create a preparation", async () => {
  for (const change of [
    { status: "unproven" as const },
    { sourceSha256: sha("another source") },
    { engineVersion: "unselected-engine" },
    { effect: "unrestricted" },
  ]) {
    const f = fixture(),
      analyze = f.ports.analyze;
    await assert.rejects(
      preparePythonDiagnostic(
        { ...f.request, readOnly: true },
        {
          ...f.ports,
          async analyze(source) {
            return { ...(await analyze(source)), ...change };
          },
        },
      ),
      { code: "PYTHON_DIAGNOSTIC_UNPROVEN" },
    );
  }
});
test("the owner and generation are rechecked after suspended analysis, and before every use", async () => {
  for (const revoke of [false, true]) {
    const f = fixture(),
      analyze = f.ports.analyze;
    await assert.rejects(
      preparePythonDiagnostic(f.request, {
        ...f.ports,
        async analyze(source) {
          const result = await analyze(source);
          if (revoke) f.revoke();
          else f.changeGeneration();
          return result;
        },
      }),
      { code: revoke ? "NOT_AUTHORIZED" : "PYTHON_DIAGNOSTIC_UNPROVEN" },
    );
  }
  const f = fixture(),
    prepared = await preparePythonDiagnostic(f.request, f.ports);
  assert.ok(prepared);
  f.changeGeneration();
  assert.throws(() => prepared.reverify(f.request), {
    code: "PYTHON_DIAGNOSTIC_UNPROVEN",
  });
});
test("only the exact supported nonpersistent script envelope reaches the producer", async () => {
  const f = fixture();
  for (const argumentsValue of [
    { code: f.source, persistent: true },
    {
      code: f.source,
      persistent: false,
      extra: "not part of the closed contract",
    },
    { code: f.source },
  ]) {
    await assert.rejects(
      preparePythonDiagnostic(
        {
          ...f.request,
          payload: {
            ...f.request.payload,
            params: { name: "execute_python", arguments: argumentsValue },
          },
        },
        f.ports,
      ),
      { code: "PYTHON_DIAGNOSTIC_UNPROVEN" },
    );
  }
  const official = {
    ...f.request,
    payload: {
      ...f.request.payload,
      params: {
        name: "fusion_mcp_execute",
        arguments: {
          featureType: "script",
          object: { script: f.source, readOnly: false },
        },
      },
    },
  };
  const prepared = await preparePythonDiagnostic(official, f.ports);
  assert.ok(prepared, "the caller flag does not classify effects");
  prepared.assertSource(official, f.source);
});
