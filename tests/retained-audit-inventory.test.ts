import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const load = createRequire(__filename);
const api = load(
  "../src/dist/node-adapters/execution/retained-audit-inventory",
) as typeof import("../packages/node-adapters/src/execution/retained-audit-inventory");
const { preparePythonArtifact } = load(
  "../src/dist/python/artifact",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { pythonArtifactManifest } = load(
  "../src/dist/python/context-binding",
) as typeof import("../packages/node-adapters/src/python/context-binding");
const canonicalHash = (
  load("../src/dist/core/application/cad/json") as {
    hash(value: unknown): string;
  }
).hash;
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

type Fixture = ReturnType<typeof writeAudit>;
type ProcessIdentity = { pid: number; birth: string; version?: string };
const retainedNames = [
  "intent.json",
  "start.json",
  "wire.json",
  "received-response.json",
  "remote-synthetic-rpc-selected.json",
  "result.json",
];

function writeAudit(
  root: string,
  id: string,
  instance: { pid: number; birth: string } = {
    pid: 710001,
    birth: "synthetic-selected-process-birth",
  },
  buildHash = "d".repeat(64),
) {
  const key = {
      jobId: `synthetic-${id}`,
      observationJobId: `synthetic-observer-${id}`,
      requestId: `synthetic-${id}:observe`,
      clientId: "synthetic-owner",
    },
    directory = path.join(
      root,
      "epoch-successions",
      `synthetic-audit-${id}`,
      "dead-epoch-current-observation",
    );
  fs.mkdirSync(directory, { recursive: true });
  const put = (name: string, value: unknown) =>
      fs.writeFileSync(path.join(directory, name), JSON.stringify(value)),
    identity = {
      resolvedIdentity: {
        creationId: `synthetic-document-${id}`,
        name: `synthetic-document-${id}`,
        fileId: null,
      },
    },
    binding = {
      purpose: "atomic-recovery-audit-v1",
      clientId: key.clientId,
      expectedProcess: instance,
      successorAuthorityHash: "a".repeat(64),
    },
    source = `print('synthetic read-only observation ${id}')`,
    originHash = hash(`synthetic-origin-${id}`),
    physical = {
      jobId: key.jobId,
      rpcId: `synthetic-rpc-${id}`,
      requestHash: hash(`synthetic-request-${id}`),
      buildHash,
      sourceHash: hash(source),
      purpose: binding.purpose,
      auditBindingHash: canonicalHash(binding),
      pythonOriginHash: originHash,
      auditExpectedProcess: instance,
    },
    artifact = preparePythonArtifact(
      [{ id: "synthetic", filename: "synthetic.py", role: "user", source }],
      { request: physical, context: { origin: { artifactHash: originHash } } },
    ),
    outgoing = {
      jsonrpc: "2.0",
      id: `fmcad:${physical.rpcId}`,
      method: "tools/call",
      params: {
        name: "fusion_mcp_execute",
        arguments: {
          featureType: "script",
          object: { script: artifact.script, readOnly: true },
        },
      },
    },
    summary = {
      version: 1,
      purpose: binding.purpose,
      profile: "atomic-recovery-counts-v1",
      requestIdentity: identity,
      nativeOutcome: "unknown",
      modelValidation: "not_performed",
      rollbackVerification: "not_performed",
      modulePresent: false,
      ui: { activeCommand: "SelectCommand", idle: true },
      commandDefinition: { status: "absent" },
      document: { status: "absent", matches: 0 },
      snapshot: null,
      fingerprint: null,
    },
    reply = {
      jsonrpc: "2.0",
      id: outgoing.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              message: "FMCAD_RESULT " + JSON.stringify(summary) + "\n",
              success: true,
            }),
          },
        ],
      },
    };
  put("intent.json", {
    version: 1,
    key,
    binding,
    identity,
    sourceArtifactHash: originHash,
    sourceSha256: hash(source),
  });
  put("start.json", {
    binding: physical,
    instance,
    receipt: path.join(directory, `remote-${physical.rpcId}.json`),
    pythonCheck: {
      status: "passed",
      provenance: {
        artifactHash: artifact.artifactHash,
        wireHash: artifact.sha256,
      },
    },
    originArtifactHash: originHash,
  });
  put("wire.json", { outgoing, artifact: pythonArtifactManifest(artifact) });
  put("received-response.json", {
    version: 1,
    binding: physical,
    wireId: outgoing.id,
    callerId: 2,
    status: 200,
    raw: JSON.stringify(reply),
  });
  put(`remote-${physical.rpcId}.json`, {
    ...physical,
    terminal: true,
    outcome: "succeeded",
    instance: {
      ...instance,
      version: "synthetic-host",
      activeCommand: "SelectCommand",
    },
  });
  put("result.json", {
    kind: "dead-epoch-current-observation",
    ...key,
    status: "failed",
    code: "AUDIT_OUTPUT_INVALID",
    sdkRequestsSent: 1,
    nativeOutcome: "unknown",
    modelValidation: "not_performed",
    rollbackVerification: "not_performed",
  });
  return {
    root,
    directory,
    key,
    identity,
    binding,
    instance,
    buildHash,
    input: {
      root,
      directory,
      key,
      identity,
      binding,
      instance,
      buildHash,
      owner: { pid: 710002, birth: "synthetic-metadata-owner-birth" },
    },
    put,
  };
}

function fixture(t: import("node:test").TestContext): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retained-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return writeAudit(root, "selected");
}

function priorProcessIsDead(expected: ProcessIdentity) {
  return (value: unknown): boolean | null => {
    if (!value || typeof value !== "object") return null;
    const identity = value as Record<string, unknown>;
    return identity["pid"] === expected.pid &&
      identity["birth"] === expected.birth
      ? false
      : null;
  };
}

function addTypedHistoricalSidecars(
  f: Fixture,
  oldProcess: ProcessIdentity = {
    pid: f.instance.pid,
    birth: "synthetic-historical-birth-before-pid-reuse",
    version: "synthetic-old-host",
  },
) {
  const oldBuildHash = "e".repeat(64),
    directory = path.join(f.root, "jobs", "historical-scratch");
  fs.mkdirSync(directory, { recursive: true });
  const binding = {
      purpose: "synthetic-historical-sdk-sidecars-v1",
      epochId: "synthetic-historical-epoch",
      document: { creationId: "synthetic-historical-document" },
      originalRpcId: "synthetic-original-rpc",
      requestId: "synthetic-historical-request",
    },
    physical = {
      jobId: "historical-scratch",
      rpcId: binding.originalRpcId,
      auditBindingHash: canonicalHash(binding),
      buildHash: oldBuildHash,
      auditExpectedProcess: oldProcess,
    };
  fs.writeFileSync(
    path.join(directory, "intent.json"),
    JSON.stringify({ nonce: "synthetic-historical-worker-nonce", binding }),
  );
  fs.writeFileSync(
    path.join(directory, "start.json"),
    JSON.stringify({ binding: physical, instance: oldProcess }),
  );
  const put = (name: string, value: unknown) =>
    fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  put("sdk-qualified.json.started", {
    epochId: binding.epochId,
    bindingHash: canonicalHash(binding),
  });
  put("sdk-qualified.json.created", {
    epochId: binding.epochId,
    creationId: "synthetic-created-id",
    bindingHash: canonicalHash(binding),
  });
  put("sdk-closed.json.started", {
    document: binding.document,
    bindingHash: canonicalHash(binding),
  });
  put("sdk-facts.json.started", {
    originalRpcId: binding.originalRpcId,
    bindingHash: canonicalHash(binding),
  });
  put("adapter-worker.json.aaaaaaaaaaaaaaaaaaaaaaaa.finished", {
    pid: oldProcess.pid,
    birth: oldProcess.birth,
    nonce: "synthetic-historical-worker-nonce",
  });
  put(
    "closed-pause-continuation-worker.json.bbbbbbbbbbbbbbbbbbbbbbbb.finished",
    {
      pid: oldProcess.pid,
      birth: oldProcess.birth,
      nonce: "synthetic-historical-worker-nonce",
      requestId: binding.requestId,
    },
  );

  const nativeDirectory = path.join(f.root, "jobs", "historical-native"),
    nativeRpcId = "d7b82710-006d-4a5d-b54d-31a7129aaac4",
    nativeBinding = {
      rpcId: nativeRpcId,
      jobId: "historical-native",
      requestId: "synthetic-native-request",
      clientId: "synthetic-owner",
      buildHash: oldBuildHash,
    };
  fs.mkdirSync(nativeDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(nativeDirectory, `rpc-${nativeRpcId}.json`),
    JSON.stringify({ binding: nativeBinding, instance: oldProcess }),
  );
  for (const stage of ["start", "end"] as const)
    fs.writeFileSync(
      path.join(
        nativeDirectory,
        `remote-${nativeRpcId}.json.native-${stage}.json`,
      ),
      JSON.stringify({
        ...nativeBinding,
        instance: oldProcess,
        stage: stage === "start" ? "native-start" : "native-completion",
        terminal: stage === "end",
      }),
    );
  return {
    oldProcess,
    names: [
      "sdk-qualified.json.started",
      "sdk-qualified.json.created",
      "sdk-closed.json.started",
      "sdk-facts.json.started",
      "adapter-worker.json.aaaaaaaaaaaaaaaaaaaaaaaa.finished",
      "closed-pause-continuation-worker.json.bbbbbbbbbbbbbbbbbbbbbbbb.finished",
      `remote-${nativeRpcId}.json.native-start.json`,
      `remote-${nativeRpcId}.json.native-end.json`,
    ],
  };
}

function inspect(
  f: Fixture,
  priorProcessAlive: (value: unknown) => boolean | null = () => null,
) {
  return api.inspectSubmittedAuditInventory(f.input, { priorProcessAlive });
}

function refuse(
  f: Fixture,
  priorProcessAlive: (value: unknown) => boolean | null = () => false,
) {
  assert.throws(() => inspect(f, priorProcessAlive));
}

test("accepts one exact retained audit without changing its six evidence records", (t) => {
  const f = fixture(t),
    before = retainedNames.map((name) =>
      fs.readFileSync(path.join(f.directory, name)),
    ),
    inventory = inspect(f);
  assert.equal(inventory.sdkRequestsSent, 1);
  assert.deepEqual(inventory.selectedProcess, f.instance);
  // This is submitted-record accounting, not global SDK closure or admission authority.
  assert.deepEqual(
    inventory.files
      .filter((entry) => path.dirname(entry.path) === f.directory)
      .map((entry) => path.basename(entry.path))
      .sort(),
    [...retainedNames].sort(),
  );
  for (const [index, name] of retainedNames.entries())
    assert.deepEqual(
      fs.readFileSync(path.join(f.directory, name)),
      before[index],
    );
});

test("preserves typed historical SDK sidecars only for the exact proven-dead old process", (t) => {
  const f = fixture(t),
    original = retainedNames.map((name) =>
      fs.readFileSync(path.join(f.directory, name)),
    ),
    history = addTypedHistoricalSidecars(f),
    checked: unknown[] = [],
    inventory = inspect(f, (value) => {
      checked.push(value);
      return priorProcessIsDead(history.oldProcess)(value);
    });
  assert.equal(inventory.sdkRequestsSent, 1);
  const result = JSON.parse(
    fs.readFileSync(path.join(f.directory, "result.json"), "utf8"),
  );
  assert.deepEqual(
    {
      status: result.status,
      code: result.code,
      nativeOutcome: result.nativeOutcome,
    },
    {
      status: "failed",
      code: "AUDIT_OUTPUT_INVALID",
      nativeOutcome: "unknown",
    },
  );
  assert.ok(checked.length > 0);
  for (const value of checked) {
    const candidate = value as Record<string, unknown>;
    assert.deepEqual(
      { pid: candidate["pid"], birth: candidate["birth"] },
      { pid: history.oldProcess.pid, birth: history.oldProcess.birth },
    );
  }
  for (const name of history.names)
    assert.ok(
      inventory.files.some((entry) => path.basename(entry.path) === name),
      `expected typed historical sidecar ${name} in the inventory`,
    );
  for (const [index, name] of retainedNames.entries())
    assert.deepEqual(
      fs.readFileSync(path.join(f.directory, name)),
      original[index],
    );
});

test("refuses a second late audit for the selected live process", (t) => {
  const f = fixture(t);
  writeAudit(f.root, "late", f.instance, f.buildHash);
  refuse(f);
});

test("refuses an unknown live SDK producer", (t) => {
  const f = fixture(t),
    directory = path.join(f.root, "jobs", "unknown-live-producer");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "unrecognized.json"),
    JSON.stringify({
      rpcId: "synthetic-unknown-live-rpc",
      instance: f.instance,
      buildHash: f.buildHash,
    }),
  );
  refuse(f);
});

test("refuses an unbound live SDK RPC producer", (t) => {
  const f = fixture(t),
    directory = path.join(f.root, "jobs", "unbound-live-producer");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "rpc-unbound.json"),
    JSON.stringify({
      rpcId: "synthetic-unbound-live-rpc",
      instance: f.instance,
      buildHash: f.buildHash,
      binding: { rpcId: "synthetic-unbound-live-rpc" },
    }),
  );
  refuse(f);
});

test("refuses late partial evidence instead of ignoring its suffix", (t) => {
  const f = fixture(t),
    directory = path.join(f.root, "jobs", "late-partial");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "late-rpc.json.partial"), "{}");
  refuse(f);
});

test("refuses missing terminal proof for the retained audit RPC", (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.directory, "remote-synthetic-rpc-selected.json"));
  refuse(f);
});

test("refuses a foreign retained owner binding", (t) => {
  const f = fixture(t),
    intent = JSON.parse(
      fs.readFileSync(path.join(f.directory, "intent.json"), "utf8"),
    );
  intent.key.clientId = "synthetic-foreign-owner";
  fs.writeFileSync(
    path.join(f.directory, "intent.json"),
    JSON.stringify(intent),
  );
  refuse(f);
});

test("refuses tampered retained wire bytes", (t) => {
  const f = fixture(t),
    wire = JSON.parse(
      fs.readFileSync(path.join(f.directory, "wire.json"), "utf8"),
    );
  wire.outgoing.params.arguments.object.script += "\nprint('tampered')";
  fs.writeFileSync(path.join(f.directory, "wire.json"), JSON.stringify(wire));
  refuse(f);
});

test("refuses a stale selected-process birth identity", (t) => {
  const f = fixture(t);
  f.input.instance = { ...f.instance, birth: "synthetic-stale-birth" };
  refuse(f);
});

for (const state of [true, null] as const)
  test(`refuses historical sidecars when old-process liveness is ${state === null ? "unknown" : "live"}`, (t) => {
    const f = fixture(t);
    addTypedHistoricalSidecars(f);
    refuse(f, () => state);
  });

test("refuses a historical sidecar that reuses the exact selected process identity", (t) => {
  const f = fixture(t);
  addTypedHistoricalSidecars(f, {
    ...f.instance,
    version: "synthetic-host",
  });
  refuse(f);
});

test("refuses a typed historical sidecar with a foreign binding hash", (t) => {
  const f = fixture(t),
    history = addTypedHistoricalSidecars(f),
    marker = path.join(
      f.root,
      "jobs",
      "historical-scratch",
      "sdk-qualified.json.started",
    ),
    value = JSON.parse(fs.readFileSync(marker, "utf8"));
  value.bindingHash = "f".repeat(64);
  fs.writeFileSync(marker, JSON.stringify(value));
  refuse(f, priorProcessIsDead(history.oldProcess));
});

test("refuses historical SDK evidence carrying the selected build identity", (t) => {
  const f = fixture(t);
  addTypedHistoricalSidecars(f);
  const startFile = path.join(
      f.root,
      "jobs",
      "historical-scratch",
      "start.json",
    ),
    start = JSON.parse(fs.readFileSync(startFile, "utf8"));
  start.binding.buildHash = f.buildHash;
  fs.writeFileSync(startFile, JSON.stringify(start));
  refuse(f);
});

test("refuses symbolic links in the submitted inventory namespace", (t) => {
  const f = fixture(t),
    jobs = path.join(f.root, "jobs"),
    target = path.join(jobs, "synthetic-target"),
    link = path.join(jobs, "synthetic-link");
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, link, "dir");
  refuse(f);
});
