import test from "node:test";
import assert from "node:assert/strict";
import { compileProtocolMetadata } from "../src/protocol-metadata-broker";

function fixture(method = "initialize") {
  const current = {
    buildHash: "a".repeat(64),
    configHash: "b".repeat(64),
    generation: "current-physical-generation",
  };
  let authorized = true;
  const request = {
    kind: "rpc" as const,
    timeoutMs: 60000,
    buildHash: current.buildHash,
    clientId: "protocol-owner",
    ownerToken: "c".repeat(64),
    requestId: "original-metadata-request",
    payload: {
      jsonrpc: "2.0",
      id: "client-original-id",
      method,
      params:
        method === "initialize"
          ? {
              protocolVersion: "2024-11-05",
              clientInfo: { name: "fmcad", version: "test" },
              capabilities: {},
            }
          : {},
    },
  };
  const ports = {
    currentPins: () => ({ ...current }),
    recheck() {
      if (!authorized) throw new Error("owner revoked");
    },
  };
  return {
    request,
    ports,
    current,
    revoke() {
      authorized = false;
    },
  };
}

test("closed transport metadata has request-bound preparation, never a dispatch grant", () => {
  for (const method of [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "ping",
  ]) {
    const f = fixture(method);
    const prepared = compileProtocolMetadata(f.request, f.ports);
    assert.ok(prepared);
    assert.equal(prepared.descriptor.kind, "protocol-metadata");
    prepared.assertRpc(f.request, f.request.payload);
    assert.equal("submit" in prepared, false);
    assert.equal("send" in prepared, false);
    assert.equal("authority" in prepared.descriptor, false);
    assert.ok(Object.isFrozen(prepared.descriptor));
    assert.throws(
      () =>
        prepared.assertRpc(f.request, {
          ...f.request.payload,
          method: "tools/call",
        }),
      { code: "PROTOCOL_METADATA_UNPROVEN" },
    );
  }
});

test("caller readonly flags and unknown methods cannot prove tool execution safe", () => {
  for (const method of ["tools/call", "execute_python", "doc.new", "unknown"]) {
    const f = fixture(method);
    assert.equal(
      compileProtocolMetadata(
        {
          ...f.request,
          payload: {
            ...f.request.payload,
            params: {
              name: "execute_python",
              arguments: {
                code: "print('advertised read only')",
                readOnly: true,
              },
            },
          },
        },
        f.ports,
      ),
      null,
    );
  }
  const f = fixture();
  assert.equal(
    compileProtocolMetadata({ ...f.request, kind: "command" }, f.ports),
    null,
  );
});

test("every use rechecks original request, RPC, current pins and ownership", () => {
  for (const key of ["requestId", "clientId", "ownerToken"]) {
    const f = fixture(),
      prepared = compileProtocolMetadata(f.request, f.ports);
    assert.ok(prepared);
    assert.throws(() => prepared.reverify({ ...f.request, [key]: "foreign" }), {
      code: "PROTOCOL_METADATA_UNPROVEN",
    });
  }
  for (const key of ["buildHash", "configHash", "generation"] as const) {
    const f = fixture(),
      prepared = compileProtocolMetadata(f.request, f.ports);
    assert.ok(prepared);
    f.current[key] = key === "generation" ? "successor" : "d".repeat(64);
    assert.throws(() => prepared.assertRpc(f.request, f.request.payload), {
      code: "PROTOCOL_METADATA_UNPROVEN",
    });
  }
  const f = fixture(),
    prepared = compileProtocolMetadata(f.request, f.ports);
  assert.ok(prepared);
  f.revoke();
  assert.throws(() => prepared.reverify(f.request), /owner revoked/);
});

test("mutating advertised copies never changes the privately prepared RPC", () => {
  const f = fixture(),
    prepared = compileProtocolMetadata(f.request, f.ports);
  assert.ok(prepared);
  assert.ok(f.request.payload.params.clientInfo);
  const original = structuredClone(f.request);
  f.request.payload.params.clientInfo.name = "mutated-after-preparation";
  assert.throws(() => prepared.reverify(f.request), {
    code: "PROTOCOL_METADATA_UNPROVEN",
  });
  prepared.assertRpc(original, original.payload);
  prepared.reverify({ ...original, description: "presentation only" });
});

test("preparation refuses stale build, missing actor identity and asynchronous owner checks", () => {
  const f = fixture();
  for (const change of [
    { buildHash: "d".repeat(64) },
    { clientId: "" },
    { requestId: "" },
    { ownerToken: undefined },
    { ownerToken: "caller assertion" },
  ]) {
    assert.throws(
      () => compileProtocolMetadata({ ...f.request, ...change }, f.ports),
      { code: "PROTOCOL_METADATA_UNPROVEN" },
    );
  }
  assert.throws(
    () =>
      compileProtocolMetadata(f.request, {
        ...f.ports,
        recheck: async () => {},
      }),
    { code: "PROTOCOL_METADATA_UNPROVEN" },
  );
});
