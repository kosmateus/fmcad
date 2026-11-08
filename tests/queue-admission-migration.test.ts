import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { ScopedPrepared } from "../src/queue-admission";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const current = load(
  "./dist/src/queue-admission",
) as typeof import("../src/queue-admission");
const historicalModule = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
  runtime: string,
) => typeof current;
const historical = historicalModule(
  "843ce0dc98d512f88c3c42124ad4f6909b69cc91",
  "src/queue-admission.js",
  "dist/src/queue-admission.js",
);
const { preparedObserver, runtime } = load(
  "./tests/fixtures/prepared-observer.cjs",
) as {
  preparedObserver(code: string, directory: string): ScopedPrepared;
  runtime: string;
};
const { buildHash } = load("./dist/src/queue-instance") as {
  buildHash(): string;
};
const code =
  "value: int = 1\ndef run(context: str) -> None:\n    print(value, context)\n";
function fixture(t: { after(fn: () => void): void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "admission-parity-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    prepared: () => structuredClone(preparedObserver(code, directory)),
  };
}
function change(
  value: unknown,
  keys: readonly (string | number)[],
  replacement: unknown,
): void {
  const [first, ...rest] = keys;
  assert.ok(first !== undefined);
  assert.ok(value && typeof value === "object");
  if (rest.length) change(Reflect.get(value, first), rest, replacement);
  else Reflect.set(value, first, replacement);
}
const mutations = [
  {
    name: "persistent session",
    keys: ["outgoing", "params", "arguments", "persistent"],
    value: true,
    code: "WORKFLOW_OBSERVATION_NOT_ALLOWED",
  },
  {
    name: "unexpected RPC argument",
    keys: ["outgoing", "params", "arguments", "session_id"],
    value: "foreign",
    code: "WORKFLOW_OBSERVATION_NOT_ALLOWED",
  },
  {
    name: "final source",
    keys: ["outgoing", "params", "arguments", "code"],
    value: "print('foreign')",
    code: "WORKFLOW_ARTIFACT_CHANGED",
  },
  {
    name: "receipt source",
    keys: ["record", "binding", "sourceHash"],
    value: "0".repeat(64),
    code: "WORKFLOW_ARTIFACT_CHANGED",
  },
  {
    name: "receipt request",
    keys: ["record", "pythonArtifact", "request"],
    value: { foreign: true },
    code: "WORKFLOW_ARTIFACT_CHANGED",
  },
  {
    name: "receipt context",
    keys: ["record", "pythonArtifact", "context"],
    value: null,
    code: "WORKFLOW_ARTIFACT_CHANGED",
  },
  {
    name: "receipt units",
    keys: ["record", "pythonArtifact", "units"],
    value: [],
    code: "WORKFLOW_ARTIFACT_CHANGED",
  },
  {
    name: "receipt source map",
    keys: ["record", "pythonArtifact", "sourceMap"],
    value: [],
    code: "WORKFLOW_ARTIFACT_CHANGED",
  },
  {
    name: "foreign build",
    keys: ["record", "binding", "buildHash"],
    value: "0".repeat(64),
    code: "WORKFLOW_ARTIFACT_CHANGED",
  },
  {
    name: "foreign RPC",
    keys: ["rpcId"],
    value: "foreign",
    code: "WORKFLOW_ARTIFACT_CHANGED",
  },
  {
    name: "foreign target",
    keys: ["record", "binding", "observationTargetJobId"],
    value: "foreign",
    code: "PYTHON_ADMISSION_UNAVAILABLE",
  },
  {
    name: "foreign identity",
    keys: ["record", "binding", "observationIdentityHash"],
    value: "0".repeat(64),
    code: "PYTHON_ADMISSION_UNAVAILABLE",
  },
  {
    name: "missing source receipts",
    keys: ["record", "atomicRuntimeAbi", "sourceReceipts"],
    value: [],
    code: "PYTHON_ADMISSION_UNAVAILABLE",
  },
  {
    name: "foreign source receipt",
    keys: ["record", "atomicRuntimeAbi", "sourceReceipts", 0, "rpcId"],
    value: "foreign",
    code: "PYTHON_ADMISSION_UNAVAILABLE",
  },
  {
    name: "unknown ABI field",
    keys: ["record", "atomicRuntimeAbi", "extra"],
    value: true,
    code: "PYTHON_ADMISSION_UNAVAILABLE",
  },
  {
    name: "missing original units",
    keys: ["pythonArtifact", "context", "origin", "units"],
    value: [],
    code: "PYTHON_ADMISSION_UNAVAILABLE",
  },
  {
    name: "foreign origin segment",
    keys: ["pythonArtifact", "context", "origin", "segments", 0, "sha256"],
    value: "0".repeat(64),
    code: "PYTHON_ADMISSION_UNAVAILABLE",
  },
  {
    name: "invalid timeout",
    keys: ["dispatchTimeoutMs"],
    value: 0,
    code: "INVALID_TIMEOUT",
  },
] as const;
for (const [name, implementation] of [
  ["retained 843ce0d / immediate predecessor", historical],
  ["typed", current],
] as const) {
  test(`${name}: exact observer source receives real admission without execution`, async (t) => {
    const f = fixture(t),
      prepared = f.prepared(),
      original = structuredClone(prepared);
    const production = implementation.createProductionQueueAdmission(runtime);
    const certificate = await production.checkPrepared(prepared);
    production.fencePrepared(prepared, buildHash());
    assert.equal(certificate.report?.status, "passed");
    assert.equal(certificate.artifact?.script, original.pythonArtifact.script);
    assert.deepEqual(prepared.outgoing, original.outgoing);
    assert.equal(fs.existsSync(prepared.record.receipt!), false);
  });
  for (const mutation of mutations)
    test(`${name}: refuses ${mutation.name} before admission`, async (t) => {
      const f = fixture(t),
        prepared = f.prepared();
      change(prepared, mutation.keys, mutation.value);
      await assert.rejects(
        implementation
          .createProductionQueueAdmission(runtime)
          .checkPrepared(prepared),
        { code: mutation.code },
      );
      assert.equal(fs.existsSync(prepared.record.receipt!), false);
    });
  test(`${name}: final fence binds the checked objects and current build`, async (t) => {
    const f = fixture(t),
      prepared = f.prepared();
    const production = implementation.createProductionQueueAdmission(runtime);
    await production.checkPrepared(prepared);
    assert.throws(
      () => production.fencePrepared({ ...prepared }, buildHash()),
      { code: "PYTHON_ADMISSION_UNAVAILABLE" },
    );
    for (const field of ["outgoing", "pythonArtifact", "record"] as const) {
      const original = prepared[field];
      Reflect.set(prepared, field, structuredClone(original));
      assert.throws(() => production.fencePrepared(prepared, buildHash()), {
        code: "PYTHON_ADMISSION_UNAVAILABLE",
      });
      Reflect.set(prepared, field, original);
    }
    assert.throws(() => production.fencePrepared(prepared, "0".repeat(64)), {
      code: "BUILD_CHANGED",
    });
    production.fencePrepared(prepared, buildHash());
  });
}

test("typed preflight hashes the actual emitted admission implementation", async (t) => {
  const f = fixture(t),
    prepared = f.prepared();
  const result = await current.migrationAdmissionPreflight(prepared);
  const bytes = fs.readFileSync(path.join(root, "dist/src/queue-admission.js"));
  assert.equal(
    result.sourceModuleHash,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(
    bytes,
    fs.readFileSync(
      path.join(root, "dist/library-build/src/queue-admission.js"),
    ),
  );
});

// These gaps are present in retained 843ce0d and the immediate predecessor.
// The same prepared objects/real checker demonstrate why the expected typed
// result must differ: evidence changed while the original bytes were checked.
for (const field of [
  "outgoing",
  "pythonArtifact",
  "record",
  "receipt",
  "dispatchTimeoutMs",
] as const) {
  for (const [name, implementation] of [
    ["retained", historical],
    ["typed", current],
  ] as const) {
    test(`${name}: replacement during real checking - ${field}`, async (t) => {
      const f = fixture(t),
        prepared = f.prepared();
      const production = implementation.createProductionQueueAdmission(runtime);
      const pending = production.checkPrepared(prepared);
      if (field === "receipt") prepared.record.receipt += "-foreign";
      else if (field === "dispatchTimeoutMs") prepared.dispatchTimeoutMs += 1;
      else if (field === "record") prepared.record = { ...prepared.record };
      else Reflect.set(prepared, field, structuredClone(prepared[field]));
      if (name === "retained")
        assert.equal((await pending).report?.status, "passed");
      else {
        await assert.rejects(pending, { code: "WORKFLOW_ARTIFACT_CHANGED" });
        assert.throws(() => production.fencePrepared(prepared, buildHash()), {
          code: "PYTHON_ADMISSION_UNAVAILABLE",
        });
      }
      assert.equal(fs.readdirSync(f.directory).length, 0);
    });
  }
}
for (const field of ["jobId", "requestHash", "unexpected"] as const) {
  for (const [name, implementation] of [
    ["retained", historical],
    ["typed", current],
  ] as const) {
    test(`${name}: receipt binding must equal the binding in the checked artifact - ${field}`, async (t) => {
      const f = fixture(t),
        prepared = f.prepared();
      change(
        prepared,
        ["record", "binding", field],
        field === "requestHash" ? "0".repeat(64) : "foreign",
      );
      const pending = implementation
        .createProductionQueueAdmission(runtime)
        .checkPrepared(prepared);
      if (name === "retained")
        assert.equal((await pending).report?.status, "passed");
      else await assert.rejects(pending, { code: "WORKFLOW_ARTIFACT_CHANGED" });
      assert.equal(fs.readdirSync(f.directory).length, 0);
    });
  }
}
test("typed final fence binds receipt location, timeout and check metadata", async (t) => {
  const f = fixture(t),
    prepared = f.prepared();
  const production = current.createProductionQueueAdmission(runtime);
  await production.checkPrepared(prepared);
  const original = prepared.record.receipt;
  prepared.record.receipt += "-foreign";
  assert.throws(() => production.fencePrepared(prepared, buildHash()), {
    code: "PYTHON_ADMISSION_UNAVAILABLE",
  });
  prepared.record.receipt = original!;
  prepared.dispatchTimeoutMs++;
  assert.throws(() => production.fencePrepared(prepared, buildHash()), {
    code: "PYTHON_ADMISSION_UNAVAILABLE",
  });
  prepared.dispatchTimeoutMs--;
  prepared.record.dispatchClass = "non-python";
  assert.throws(() => production.fencePrepared(prepared, buildHash()), {
    code: "PYTHON_ADMISSION_UNAVAILABLE",
  });
  prepared.record.dispatchClass = "python";
  production.fencePrepared(prepared, buildHash());
});

test("production admission cancels local analysis without a physical execution", async (t) => {
  const f = fixture(t),
    prepared = f.prepared();
  const production = current.createProductionQueueAdmission(runtime);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    production.admission.check(prepared.outgoing, prepared.pythonArtifact, {
      signal: controller.signal,
    }),
    {
      code: "PYTHON_CHECK_REJECTED",
      executionOutcome: "not_started",
      mayHaveMutated: false,
    },
  );
  assert.throws(() => production.fencePrepared(prepared, buildHash()), {
    code: "PYTHON_ADMISSION_UNAVAILABLE",
  });
  assert.equal(fs.readdirSync(f.directory).length, 0);
});

type PreparedAudit = Parameters<
  typeof current.recoveryAuditAdmissionPreflight
>[0];
function auditFixture(directory: string): PreparedAudit {
  const api = load("./src/queue-atomic-recovery-audit") as {
    prepareRecoveryAudit(
      root: string,
      identity: unknown,
      binding: unknown,
    ): { artifact: { script: string } };
    prepareRecoveryAuditWire(options: Record<string, unknown>): PreparedAudit;
  };
  const identity = {
    commandId: "fmcad_atomic_" + "a".repeat(32),
    resolvedIdentity: { name: "Owned", creationId: "owned-id", fileId: null },
  };
  const binding = {
    purpose: "atomic-recovery-audit-v1",
    currentInstance: { pid: 456, birth: "current", version: "fixture" },
    historicalInstance: { pid: 123, birth: "old", version: "fixture" },
    historicalProcessState: "terminated",
  };
  const reader = api.prepareRecoveryAudit(root, identity, binding);
  // Only spell the target Windows receipt path. No input Python is executed.
  const restore = (
    load("./tests/fixtures/fake-wsl-platform.cjs") as () => () => void
  )();
  try {
    return api.prepareRecoveryAuditWire({
      reader,
      auditBinding: binding,
      buildHash: buildHash(),
      jobId: "fixture",
      rpcId: "11111111-1111-4111-8111-111111111111",
      receipt: path.join(directory, "audit.json"),
      instance: binding.currentInstance,
      payload: {
        jsonrpc: "2.0",
        id: "fixture",
        method: "tools/call",
        params: {
          name: "execute_python",
          arguments: {
            code: reader.artifact.script + '\n\nrun("")\n',
            persistent: false,
          },
        },
      },
    });
  } finally {
    restore();
  }
}
for (const [name, implementation] of [
  ["retained", historical],
  ["typed", current],
] as const) {
  test(`${name}: recovery preflight preserves canonical source and sends nothing`, async (t) => {
    const f = fixture(t),
      prepared = auditFixture(f.directory);
    const original = structuredClone(prepared);
    const result =
      await implementation.recoveryAuditAdmissionPreflight(prepared);
    assert.equal(result.status, "passed");
    assert.equal(result.purpose, "atomic-recovery-audit-v1");
    assert.equal(result.artifactHash, prepared.artifact.artifactHash);
    assert.deepEqual(prepared, original);
    assert.equal(fs.readdirSync(f.directory).length, 0);
  });
  test(`${name}: recovery metadata cannot change during real analysis`, async (t) => {
    const f = fixture(t),
      prepared = auditFixture(f.directory);
    const pending = implementation.recoveryAuditAdmissionPreflight(prepared);
    prepared.record.binding.sourceHash = "0".repeat(64);
    if (name === "retained")
      assert.equal((await pending).sourceHash, "0".repeat(64));
    else await assert.rejects(pending, { code: "WORKFLOW_ARTIFACT_CHANGED" });
    assert.equal(fs.readdirSync(f.directory).length, 0);
  });
}

for (const [name, implementation] of [
  ["retained", historical],
  ["typed", current],
] as const) {
  test(`${name}: changed typing resources invalidate a real certificate`, async (t) => {
    const f = fixture(t),
      prepared = f.prepared();
    const localRuntime = path.join(f.directory, "runtime");
    const typing = path.join(localRuntime, "typing");
    fs.cpSync(path.join(runtime, "typing"), typing, { recursive: true });
    const production =
      implementation.createProductionQueueAdmission(localRuntime);
    const before = production.checkerFingerprint();
    await production.checkPrepared(prepared);
    fs.writeFileSync(
      path.join(typing, "changed-after-admission.pyi"),
      "changed: int\n",
    );
    assert.notEqual(production.checkerFingerprint(), before);
    assert.throws(() => production.fencePrepared(prepared, buildHash()), {
      code: "PYTHON_ADMISSION_CHANGED",
    });
    assert.equal(fs.existsSync(prepared.record.receipt!), false);
  });
}
