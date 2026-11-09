import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { present } from "./modeling-unit-test-support";
const sourceDirectory = path.join(process.cwd(), "tests");
const sourceFile = path.join(sourceDirectory, "instance-loss-recovery.test.ts");
const loadModule = createRequire(sourceFile);

const { requireInstanceProcess, requireRecoveryProcesses } = loadModule(
  "../src/queue-instance-liveness",
) as typeof import("../src/queue-instance-liveness");
const { prepareRecoveryAudit, prepareRecoveryAuditWire } = loadModule(
  "../src/queue-atomic-recovery-audit",
) as typeof import("../src/queue-atomic-recovery-audit");
const { recoveryAuditAdmissionPreflight } = loadModule(
  "../src/queue-admission",
) as typeof import("../src/queue-admission");
const { buildHash, wrapScript } = loadModule(
  "../src/queue-instance",
) as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;

const original = { pid: 123, birth: "old", version: "2706" };
const current = { pid: 456, birth: "new", version: "2706" };
const upgrade = {
  purpose: "atomic-recovery-process-loss-audit-upgrade-v1",
  currentInstance: current,
};

test("preflight live observation is point-in-time; apply must refuse after the process dies", () => {
  let alive = true;
  const observe = () => alive;
  const preflight = requireInstanceProcess(original, "live", observe);
  assert.equal(preflight.live, true);
  assert.match(preflight.observedAt, /^\d{4}-/);
  alive = false;
  assert.throws(() => requireRecoveryProcesses(original, null, observe), {
    code: "INSTANCE_CHANGED",
  });
  assert.equal(
    preflight.live,
    true,
    "a historical observation is never rewritten as current authority",
  );
});

test("process-loss purpose proves old death and distinct current liveness, never native/model outcome", () => {
  const observed = requireRecoveryProcesses(
    original,
    upgrade,
    (instance) => instance.birth === "new",
  );
  assert.equal(observed.historical.live, false);
  assert.equal(present(observed.current).live, true);
  assert.equal(observed.historicalOutcome, "unknown");
  assert.equal(observed.endpointVerified, false);
  for (const observe of [() => true, () => false, () => null])
    assert.throws(() => requireRecoveryProcesses(original, upgrade, observe));
  assert.throws(() =>
    requireRecoveryProcesses(
      original,
      { ...upgrade, currentInstance: original },
      () => false,
    ),
  );
});

test("unknown process observation is not death, same PID with a new birth is not the original instance", () => {
  assert.throws(
    () => requireInstanceProcess(original, "terminated", () => null),
    { code: "INSTANCE_LIVENESS_UNAVAILABLE" },
  );
  assert.throws(() => requireInstanceProcess(original, "skip", () => false), {
    code: "INVALID_INSTANCE_EXPECTATION",
  });
  const reused = { ...current, pid: original.pid };
  const facts = requireRecoveryProcesses(
    original,
    { ...upgrade, currentInstance: reused },
    (row) => row.birth === "new",
  );
  assert.equal(facts.historical.live, false);
  assert.equal(present(facts.current).pid, original.pid);
  assert.equal(present(facts.current).birth, "new");
});

test("receipt identity fence rejects a foreign endpoint BEFORE any audit body statement", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instance-endpoint-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receipt = path.join(dir, "receipt.json");
  const binding = {
    jobId: "fixture",
    rpcId: "fixture",
    sourceHash: "fixture",
    buildHash: "fixture",
    requestHash: "fixture",
    purpose: "atomic-recovery-audit-v1",
    auditExpectedInstance: current,
  };
  const wrapped = wrapScript(
    "app.audit_body_executed = True",
    false,
    receipt,
    binding,
    { mapPath: (file) => file },
  );
  const bootstrap = `import sys, types, json
app=types.SimpleNamespace(version='different-endpoint',userInterface=types.SimpleNamespace(activeCommand='SelectCommand'))
adsk,core=types.ModuleType('adsk'),types.ModuleType('adsk.core')
core.Application=types.SimpleNamespace(get=lambda:app);adsk.core=core
sys.modules.update({'adsk':adsk,'adsk.core':core})
`;
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      bootstrap +
        `
try:
    exec(${JSON.stringify(wrapped)})
except RuntimeError as error:
    assert str(error) == 'Audit endpoint instance changed; no audit body executed'
else:
    raise AssertionError('Expected endpoint guard')
assert not hasattr(app,'audit_body_executed')
with open(${JSON.stringify(receipt)}) as f: receipt=json.load(f)
assert receipt['outcome']=='failed'
assert receipt['terminal'] is True
print('no-body-executed')
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no-body-executed/);
});

test(
  "real current-only preflight checks complete endpoint-fenced bytes and refuses stripped instance binding",
  { timeout: 30000 },
  async (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "loss-audit-preflight-"),
    );
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const context = {
      purpose: "atomic-recovery-audit-v1",
      currentInstance: current,
      historicalInstance: original,
      historicalProcessState: "terminated",
    };
    const identity = {
      commandId: "fmcad_atomic_" + "a".repeat(32),
      resolvedIdentity: { name: "Owned", creationId: "own", fileId: null },
    };
    const reader = prepareRecoveryAudit(
      path.resolve(sourceDirectory, ".."),
      identity,
      context,
    );
    const prepare = () => {
      const restore = (
        loadModule("./fixtures/fake-wsl-platform.cjs") as () => () => void
      )();
      try {
        return prepareRecoveryAuditWire({
          reader,
          auditBinding: context,
          buildHash: buildHash(),
          jobId: "fixture",
          rpcId: "11111111-1111-4111-8111-111111111111",
          receipt: path.join(directory, "not-sent-loss-audit.json"),
          instance: current,
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
    };
    const first = await recoveryAuditAdmissionPreflight(prepare());
    assert.equal(first.status, "passed");
    assert.deepEqual(await recoveryAuditAdmissionPreflight(prepare()), first);
    const stripped = prepare();
    delete stripped.record.binding["auditExpectedInstance"];
    await assert.rejects(recoveryAuditAdmissionPreflight(stripped));
    assert.deepEqual(fs.readdirSync(directory), []);
  },
);
