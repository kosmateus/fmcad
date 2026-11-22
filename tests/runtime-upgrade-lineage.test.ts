import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { EffectivePredecessorIdentity } from "../src/queue-epoch-lineage";

const runtime = process.env["FMCAD_TEST_RUNTIME"] || process.cwd();
const load = createRequire(
  path.join(process.cwd(), "tests/runtime-upgrade-lineage.test.js"),
);
const fixture = load("./fixtures/runtime-upgrade-lineage.cjs") as (
  base: string,
  runtime: string,
  restartTamper?: string,
) => {
  verify(): EffectivePredecessorIdentity;
  tamperCurrentProof(kind: string): void;
  current: { identity: EffectivePredecessorIdentity };
  root: string;
  pointer: { root: string; currentInstance: { pid: number; birth: string } };
};

test("successor lineage authenticates two runtime upgrades after a dead SDK replacement", (t) => {
  const base = fs.mkdtempSync("/tmp/opencode/runtime-lineage-");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const f = fixture(base, runtime);
  const files = [
    path.join(f.root, "queue-state.json"),
    path.join(f.pointer.root, "queue-state.json"),
    path.join(f.root, "isolated-admission-epoch.json"),
  ];
  const before = files.map((file) => fs.readFileSync(file));
  const { buildHash, configHash, instance } = f.current.identity;
  assert.deepEqual(f.verify(), {
    buildHash,
    configHash,
    instance: {
      pid: instance.pid,
      birth: instance.birth,
      version: instance.version,
    },
  });
  assert.notEqual(instance.pid, f.pointer.currentInstance.pid);
  assert.deepEqual(
    files.map((file) => fs.readFileSync(file)),
    before,
  );
});

for (const kind of [
  "sdk-birth",
  "source-ref",
  "skip-head",
  "startup-ref",
  "lifecycle-ref",
  "owner",
  "epoch",
  "build",
  "pending",
  "unknown",
  "generation",
  "unpaused",
  "active",
  "stop-request",
  "missing-evidence",
  "worker",
]) {
  test(`successor rejects rehashed runtime upgrade ${kind}`, (t) => {
    const base = fs.mkdtempSync("/tmp/opencode/runtime-lineage-negative-");
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const f = fixture(base, runtime);
    f.tamperCurrentProof(kind);
    assert.throws(() => f.verify(), { code: "EPOCH_LINEAGE_INVALID" });
  });
}

for (const kind of [
  "restart-build",
  "binding-build",
  "config",
  "sdk-birth",
  "pointer",
  "missing-link",
  "state",
  "receipt",
]) {
  test(`successor rejects rehashed normal restart ${kind}`, (t) => {
    const base = fs.mkdtempSync("/tmp/opencode/normal-lineage-negative-");
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const f = fixture(base, runtime, kind);
    assert.throws(
      () => f.verify(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("code" in error);
        assert.ok(
          [
            "NORMAL_RESTART_UNPROVEN",
            "EPOCH_LINEAGE_INVALID",
            "ENOENT",
          ].includes(String(error.code)),
        );
        return true;
      },
    );
  });
}
