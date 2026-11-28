import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { QueueDomain } from "../packages/core/src/domain/queue";
import {
  hash as canonicalHash,
  canonical,
} from "../packages/core/src/application/cad/json";
import {
  createRuntimeRetirementAuthority,
  projectRuntimeRetirement,
} from "../packages/core/src/domain/runtime-retirement";
import {
  createPythonStdoutAuthority,
  verifiedPythonStdout,
  type PythonStdout,
} from "../packages/core/src/domain/python-stdout";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function fixture() {
  let id = 0,
    authorized = true;
  const options = { now: () => 1000, newId: () => `stdout-${++id}`, hash };
  const state = new QueueDomain(options);
  const source = 'print("literal marker")';
  const request = {
    kind: "rpc" as const,
    clientId: "owner",
    requestId: "stdout-original",
    timeoutMs: 45000,
    payload: {
      jsonrpc: "2.0",
      id: "logical",
      method: "tools/call",
      params: {
        name: "execute_python",
        arguments: { code: source, persistent: false },
      },
    },
  };
  const marker: PythonStdout = {
    version: 1,
    kind: "python-stdout",
    engineVersion: "python-source-effects-v2",
    profileVersion: "isolated-stdout-v1",
    requestHash: canonicalHash(request),
    rpcHash: hash("original compiled RPC"),
    sourceHash: hash(source),
    programHash: hash("compiler program"),
    hostBindingHash: hash("private host proof"),
    generation: "fresh-qualified-host",
  };
  const verify = () => {
    if (!authorized)
      throw Object.assign(new Error("Host proof revoked"), {
        code: "HOST_BINDINGS_UNPROVEN",
      });
    return marker;
  };
  return {
    state,
    options,
    request,
    marker,
    verify,
    revoke() {
      authorized = false;
    },
    authority: () => state.createPythonStdoutAuthority(verify),
  };
}
test("stdout authority is private to its domain, copied witnesses never reconstruct it", () => {
  const f = fixture(),
    authority = createPythonStdoutAuthority(f.state, f.verify);
  assert.deepEqual(verifiedPythonStdout(authority, f.state), f.marker);
  assert.throws(
    () => verifiedPythonStdout(JSON.parse(JSON.stringify(authority)), f.state),
    { code: "PYTHON_STDOUT_UNPROVEN" },
  );
  assert.throws(() => verifiedPythonStdout(authority, {}), {
    code: "PYTHON_STDOUT_UNPROVEN",
  });
  f.revoke();
  assert.throws(() => verifiedPythonStdout(authority, f.state), {
    code: "HOST_BINDINGS_UNPROVEN",
  });
});
test("one admitted stdout job retains its original request and RPC, never a restored permission", () => {
  const f = fixture();
  const result = f.state.submitPythonStdout(
    f.request,
    f.authority(),
    "original-prepared-id",
  );
  const id = String(result["id"]);
  assert.equal(id, "original-prepared-id");
  assert.equal(f.state.submitPythonStdout(f.request, f.authority())["id"], id);
  const restored = new QueueDomain({
    ...f.options,
    snapshot: JSON.parse(JSON.stringify(f.state.data)),
  });
  assert.equal(restored.hasPythonStdout(id), false);
  assert.equal(restored.next(), null);
  assert.equal(restored.data.jobs[id]?.code, "PYTHON_STDOUT_UNPROVEN");
  assert.equal(f.state.next()?.id, id);
  f.state.assertPythonStdout(id, f.marker.programHash, f.marker.rpcHash);
  f.state.markDispatch(id, { rpcId: "original-rpc", rpcState: "sending" });
  f.state.assertPythonStdout(
    id,
    f.marker.programHash,
    f.marker.rpcHash,
    "original-rpc",
  );
  assert.throws(
    () => f.state.markDispatch(id, { rpcId: "other-rpc", rpcState: "sending" }),
    { code: "PYTHON_STDOUT_UNPROVEN" },
  );
  f.state.markDispatch(id, {
    rpcId: "original-rpc",
    rpcCount: 1,
    completedCount: 1,
    rpcState: "terminal",
  });
  f.state.finish(id, {
    code: "EXECUTION_COMPLETE",
    sdkSettled: true,
    mayHaveMutated: false,
  });
  assert.equal(f.state.hasPythonStdout(id), false);
  assert.equal(f.state.submitPythonStdout(f.request, f.authority())["id"], id);
  assert.equal(f.state.hasPythonStdout(id), false);
});
test("wrong original source or persistent execution cannot cross the private proof", () => {
  for (const args of [
    { code: "different_source()", persistent: false },
    { code: 'print("literal marker")', persistent: true },
  ]) {
    const f = fixture();
    const request = {
      ...f.request,
      payload: {
        ...f.request.payload,
        params: { ...f.request.payload.params, arguments: args },
      },
    };
    const authority = f.state.createPythonStdoutAuthority(() => ({
      ...f.marker,
      requestHash: canonicalHash(request),
    }));
    assert.throws(() => f.state.submitPythonStdout(request, authority), {
      code: "PYTHON_STDOUT_UNPROVEN",
    });
  }
  const f = fixture();
  const id = String(f.state.submitPythonStdout(f.request, f.authority())["id"]);
  f.revoke();
  assert.equal(f.state.next(), null);
  assert.equal(f.state.data.jobs[id]?.code, "PYTHON_STDOUT_UNPROVEN");
});
test("stdout crosses only verified retired conflicts and never changes the historical UNKNOWN", () => {
  const f = fixture(),
    original = f.state;
  const oldId = String(
    original.submit({ ...f.request, requestId: "old-unknown" })["id"],
  );
  original.next();
  original.markDispatch(oldId);
  original.block(oldId, { code: "PRESERVED_UNKNOWN" });
  original.pause(true);
  const frozen = structuredClone(original.data),
    old = frozen.jobs[oldId];
  assert.ok(old);
  const marker = {
    rootHead: "a".repeat(64),
    recordDigest: "b".repeat(64),
    layer: "root",
    frozenDigest: hash(JSON.stringify(frozen)),
  };
  const exposure = {
    kind: "runtime_retired" as const,
    key: "root:" + oldId,
    rootHead: marker.rootHead,
    recordDigest: marker.recordDigest,
    layer: marker.layer,
    entryDigest: canonicalHash(old),
    target: null,
    source: {
      kind: "job" as const,
      jobId: oldId,
      requestId: old.requestId,
      clientId: old.clientId,
      jobHash: old.hash,
      catalogDigest: canonicalHash(old.dispatch),
    },
  };
  const retirement = createRuntimeRetirementAuthority(() => ({
    marker,
    frozen,
    currentSnapshotDigest: marker.frozenDigest,
    jobs: { [oldId]: { original: old, outcome: "unknown" } },
    exposures: { [exposure.key]: exposure },
  }));
  const projected = projectRuntimeRetirement(
    frozen,
    retirement,
    canonical,
    hash,
    200,
  );
  const state = new QueueDomain({
    ...f.options,
    snapshot: projected,
    runtimeRetirement: retirement,
  });
  state.pause(false);
  const before = JSON.stringify(state.data.jobs[oldId]);
  assert.throws(
    () =>
      original.submitPythonStdout(
        f.request,
        original.createPythonStdoutAuthority(f.verify),
      ),
    { code: "PYTHON_STDOUT_UNPROVEN" },
  );
  assert.equal(
    state.submit({ ...f.request, requestId: "raw-without-private-capability" })[
      "code"
    ],
    "UNKNOWN_SCOPE_UNPROVEN",
  );
  const admitted = state.submitPythonStdout(
    f.request,
    state.createPythonStdoutAuthority(f.verify),
  );
  assert.equal(state.next()?.id, admitted["id"]);
  assert.equal(JSON.stringify(state.data.jobs[oldId]), before);
  assert.equal(state.data.jobs[oldId]?.state, "needs_reconciliation");
  assert.equal(Object.keys(state.data.runtimeRetiredExposures ?? {}).length, 1);
});
