import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  preparePythonDiagnostic,
  type DiagnosticPreparationPorts,
} from "../src/python-diagnostic-broker";

const sha = (source: string) =>
  createHash("sha256").update(source).digest("hex");
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
