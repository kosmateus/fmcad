import test from "node:test";
import assert from "node:assert/strict";
import {
  compileProtocolMetadata,
  createProtocolMetadataBroker,
} from "../src/protocol-metadata-broker";
import { QueueDomain } from "../packages/core/src/domain/queue";
import {
  hash as canonicalHash,
  canonical,
} from "../packages/core/src/application/cad/json";
import { createHash } from "node:crypto";
import {
  createRuntimeRetirementAuthority,
  projectRuntimeRetirement,
} from "../packages/core/src/domain/runtime-retirement";
import {
  createProtocolMetadataAuthority,
  verifiedProtocolMetadata,
} from "../packages/core/src/domain/protocol-metadata";

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
    backend: "addin",
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
    { backend: "mcp" },
    { backend: undefined },
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

test("private metadata authority cannot be serialized, transferred to another domain or cached", () => {
  const f = fixture();
  const prepared = compileProtocolMetadata(f.request, f.ports);
  assert.ok(prepared);
  const domain = {};
  let checks = 0;
  const authority = createProtocolMetadataAuthority(domain, () => {
    checks++;
    prepared.reverify(f.request);
    return prepared.descriptor;
  });
  const first = verifiedProtocolMetadata(authority, domain);
  assert.deepEqual(first, prepared.descriptor);
  assert.notEqual(first, prepared.descriptor);
  assert.ok(Object.isFrozen(first));
  verifiedProtocolMetadata(authority, domain);
  assert.equal(checks, 2);
  assert.throws(() => verifiedProtocolMetadata(authority, {}), {
    code: "PROTOCOL_METADATA_UNPROVEN",
  });
  assert.throws(
    () =>
      verifiedProtocolMetadata(JSON.parse(JSON.stringify(authority)), domain),
    { code: "PROTOCOL_METADATA_UNPROVEN" },
  );
  f.revoke();
  assert.throws(
    () => verifiedProtocolMetadata(authority, domain),
    /owner revoked/,
  );
});

function queue() {
  let id = 0;
  const options = {
    now: () => 1000,
    newId: () => `protocol-job-${++id}`,
    hash: (value: string) => createHash("sha256").update(value).digest("hex"),
  };
  return { state: new QueueDomain(options), options };
}

test("domain binds one original protocol RPC and never rearms a duplicate or serialized permission", () => {
  const f = fixture(),
    { state, options } = queue();
  const prepared = compileProtocolMetadata(f.request, f.ports);
  assert.ok(prepared);
  const authority = () =>
    state.createProtocolMetadataAuthority(() => {
      prepared.reverify(f.request);
      return prepared.descriptor;
    });
  const submitted = state.submitProtocolMetadata(
    f.request,
    authority(),
    "prepared-protocol-job",
  );
  const id = String(submitted["id"]);
  assert.equal(id, "prepared-protocol-job");
  assert.equal(state.submitProtocolMetadata(f.request, authority())["id"], id);
  assert.equal(state.hasProtocolMetadata(id), true);

  const restarted = new QueueDomain({
    ...options,
    snapshot: JSON.parse(JSON.stringify(state.data)),
  });
  assert.equal(restarted.hasProtocolMetadata(id), false);
  assert.equal(restarted.next(), null);
  assert.equal(restarted.data.jobs[id]?.state, "failed");
  assert.equal(restarted.data.jobs[id]?.code, "PROTOCOL_METADATA_UNPROVEN");

  assert.equal(state.next()?.id, id);
  state.assertProtocolMetadata(id, prepared.descriptor.rpcHash);
  state.markDispatch(id, { rpcId: "protocol-rpc", rpcState: "sending" });
  state.assertProtocolMetadata(id, prepared.descriptor.rpcHash, "protocol-rpc");
  assert.throws(
    () =>
      state.assertProtocolMetadata(
        id,
        prepared.descriptor.rpcHash,
        "another-rpc",
      ),
    { code: "PROTOCOL_METADATA_UNPROVEN" },
  );
  assert.throws(
    () => state.markDispatch(id, { rpcId: "another-rpc", rpcState: "sending" }),
    { code: "PROTOCOL_METADATA_UNPROVEN" },
  );
  state.markDispatch(id, {
    rpcId: "protocol-rpc",
    rpcCount: 1,
    completedCount: 1,
    rpcState: "terminal",
  });
  assert.throws(
    () =>
      state.assertProtocolMetadata(
        id,
        prepared.descriptor.rpcHash,
        "protocol-rpc",
      ),
    { code: "PROTOCOL_METADATA_UNPROVEN" },
  );
  state.finish(id, {
    code: "EXECUTION_COMPLETE",
    sdkSettled: true,
    mayHaveMutated: false,
  });
  assert.equal(state.hasProtocolMetadata(id), false);
  assert.equal(state.submitProtocolMetadata(f.request, authority())["id"], id);
  assert.equal(state.hasProtocolMetadata(id), false);
});

test("domain refuses a tool-call even if a faulty private producer supplied matching hashes", () => {
  const f = fixture(),
    { state } = queue();
  const request = {
    ...f.request,
    payload: {
      jsonrpc: "2.0",
      id: "unsafe",
      method: "tools/call",
      params: {
        name: "execute_python",
        arguments: { code: "mutate()", readOnly: true },
      },
    },
  };
  const authority = state.createProtocolMetadataAuthority(() => ({
    version: 1,
    kind: "protocol-metadata",
    requestHash: canonicalHash(request),
    rpcHash: canonicalHash(request.payload),
    generation: f.current.generation,
  }));
  assert.throws(() => state.submitProtocolMetadata(request, authority), {
    code: "PROTOCOL_METADATA_UNPROVEN",
  });
  assert.equal(Object.keys(state.data.jobs).length, 0);
});

test("a revoked queued protocol proof fails only its job before any dispatch", () => {
  const f = fixture(),
    { state } = queue();
  const prepared = compileProtocolMetadata(f.request, f.ports);
  assert.ok(prepared);
  const authority = state.createProtocolMetadataAuthority(() => {
    prepared.reverify(f.request);
    return prepared.descriptor;
  });
  const result = state.submitProtocolMetadata(f.request, authority);
  const id = String(result["id"]);
  f.current.generation = "successor-generation";
  assert.equal(state.next(), null);
  assert.equal(state.data.jobs[id]?.state, "failed");
  assert.equal(state.data.jobs[id]?.code, "PROTOCOL_METADATA_UNPROVEN");
  assert.equal(state.data.jobs[id]?.dispatch, undefined);
});

test("protocol metadata crosses verified retired conflicts without clearing the original UNKNOWN", () => {
  // Real domain transitions with a controlled trusted-verifier port, not a live
  // host-retirement claim or a serialized fenceKind shortcut.
  const { state: original, options } = queue();
  const accepted = original.submit({
    kind: "rpc",
    clientId: "retired-owner",
    requestId: "original-unknown",
    timeoutMs: 1000,
    payload: {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "execute_python" },
    },
  });
  const oldId = String(accepted["id"]);
  original.next();
  original.markDispatch(oldId);
  original.block(oldId, { code: "ORIGINAL_UNKNOWN_EVIDENCE" });
  original.pause(true);
  const frozen = structuredClone(original.data);
  const old = frozen.jobs[oldId];
  assert.ok(old);
  const marker = {
    rootHead: "a".repeat(64),
    recordDigest: "b".repeat(64),
    layer: "root",
    frozenDigest: options.hash(JSON.stringify(frozen)),
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
    options.hash,
    200,
  );
  const state = new QueueDomain({
    ...options,
    snapshot: projected,
    runtimeRetirement: retirement,
  });
  assert.equal(Object.keys(state.data.runtimeRetiredExposures ?? {}).length, 1);
  state.pause(false);
  const f = fixture();
  const prepared = compileProtocolMetadata(f.request, f.ports);
  assert.ok(prepared);
  const cap = (domain: QueueDomain) =>
    domain.createProtocolMetadataAuthority(() => {
      prepared.reverify(f.request);
      return prepared.descriptor;
    });
  // An unfenced active UNKNOWN still blocks even this closed metadata path.
  assert.throws(
    () => original.submitProtocolMetadata(f.request, cap(original)),
    { code: "PROTOCOL_METADATA_UNPROVEN" },
  );
  const before = JSON.stringify(state.data.jobs[oldId]);
  const denied = state.submit({
    ...f.request,
    requestId: "unproved-raw-metadata",
  });
  assert.equal(denied["code"], "UNKNOWN_SCOPE_UNPROVEN");
  const allowed = state.submitProtocolMetadata(f.request, cap(state));
  assert.equal(allowed["state"], "queued");
  assert.equal(state.next()?.id, allowed["id"]);
  assert.equal(state.data.jobs[oldId]?.state, "needs_reconciliation");
  assert.equal(JSON.stringify(state.data.jobs[oldId]), before);
  assert.equal(Object.keys(state.data.runtimeRetiredExposures ?? {}).length, 1);
});

test("the broker registry binds the complete wire RPC and cannot restore witnesses from queued JSON", () => {
  const f = fixture(),
    { state } = queue();
  const broker = createProtocolMetadataBroker();
  const prepared = broker.prepare(f.request, f.ports);
  assert.ok(prepared);
  const authority = state.createProtocolMetadataAuthority(() => {
    prepared.reverify(f.request);
    return prepared.descriptor;
  });
  const result = state.submitProtocolMetadata(f.request, authority);
  const job = state.data.jobs[String(result["id"])];
  assert.ok(job);
  assert.throws(() => broker.admit(job, { ...prepared }), {
    code: "PROTOCOL_METADATA_UNPROVEN",
  });
  broker.admit(job, prepared);
  const wire = { ...structuredClone(f.request.payload), id: "fmcad:owned-rpc" };
  broker.assertWire(job, wire, "owned-rpc");
  for (const changed of [
    { ...wire, id: "fmcad:foreign-rpc" },
    { ...wire, method: "tools/call" },
    { ...wire, params: { changed: true } },
    { ...wire, extra: "unadvertised data" },
  ])
    assert.throws(() => broker.assertWire(job, changed, "owned-rpc"), {
      code: "PROTOCOL_METADATA_UNPROVEN",
    });
  assert.throws(() => createProtocolMetadataBroker().program(job), {
    code: "PROTOCOL_METADATA_UNPROVEN",
  });
  assert.throws(() => broker.admit(job, prepared), {
    code: "PROTOCOL_METADATA_UNPROVEN",
  });
  broker.prune(() => undefined);
  assert.throws(() => broker.program(job), {
    code: "PROTOCOL_METADATA_UNPROVEN",
  });
});
