import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import type {
  createAuditUpgrade,
  AuditUpgradeProof,
} from "../packages/node-adapters/src/execution/audit-upgrade";
const load = createRequire(__filename);
type Reader = ReturnType<typeof createAuditUpgrade>;
const current = load("../src/queue-atomic-audit-upgrade") as Reader;
const historicalModule = load("./fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
) => unknown;
const historical = historicalModule(
  "330849f22302bcf0ee955cd1945ddb2040eff8c7",
  "src/queue-atomic-audit-upgrade.js",
) as Reader;
const history = load("./fixtures/atomic-audit-upgrade.cjs") as (
  dir: string,
  snapshot: unknown,
) => {
  approval: {
    purpose: string;
    auditUpgrade: {
      previousComplete: { path: string; sha256: string };
      observationProof: { path: string; sha256: string };
    };
  };
  upgrade: AuditUpgradeProof;
};
test("typed second handoff keeps exact predecessor purpose and immutable evidence", (t) => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "audit-upgrade-parity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const instance = { pid: 1, birth: "fixture:old", version: "fixture" };
  const f = history(dir, {
    owner: { nonce: "previous" },
    identity: { buildHash: "original", instance },
    status: { control: { buildHash: "departing" } },
  });
  assert.deepEqual(
    current.auditUpgradeApproval(f.approval, dir),
    historical.auditUpgradeApproval(f.approval, dir),
  );
  for (const purpose of [
    "atomic-recovery-process-loss-audit-upgrade-v1",
    "unsupported-purpose",
  ]) {
    const approval = {
      ...f.approval,
      purpose,
      currentInstance: { pid: 2, birth: "fixture:new", version: "fixture" },
    };
    if (purpose === "unsupported-purpose") {
      for (const reader of [current, historical])
        assert.throws(() => reader.auditUpgradeApproval(approval, dir));
    } else
      assert.deepEqual(
        current.auditUpgradeApproval(approval, dir),
        historical.auditUpgradeApproval(approval, dir),
      );
  }
  assert.equal(current.auditUpgradeStillCurrent(f.upgrade), true);
  fs.appendFileSync(f.approval.auditUpgrade.observationProof.path, "\n");
  for (const reader of [current, historical]) {
    assert.throws(() => reader.auditUpgradeApproval(f.approval, dir), {
      code: "AUDIT_UPGRADE_PROOF_INVALID",
    });
    assert.equal(reader.auditUpgradeStillCurrent(f.upgrade), false);
  }
});

test("missing departing build cannot become authority even when all files are rehashed", (t) => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "audit-upgrade-no-build-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = history(dir, {
    owner: { nonce: "previous" },
    identity: {
      buildHash: "original",
      instance: { pid: 1, birth: "fixture:old", version: "fixture" },
    },
    status: { control: { buildHash: "departing" } },
  });
  const update = (file: string, key: string, nested?: string) => {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    delete value[key];
    if (nested) {
      const inner = value[nested];
      assert.ok(inner && typeof inner === "object" && !Array.isArray(inner));
      delete (inner as Record<string, unknown>)["buildHash"];
    }
    fs.writeFileSync(file, JSON.stringify(value));
  };
  update(f.approval.auditUpgrade.previousComplete.path, "observerBuildHash");
  update(
    f.approval.auditUpgrade.observationProof.path,
    "observerBuildHash",
    "binding",
  );
  update(f.upgrade.remoteReceipt.path, "buildHash");
  const crypto = load("node:crypto") as typeof import("node:crypto");
  for (const entry of [
    f.approval.auditUpgrade.previousComplete,
    f.approval.auditUpgrade.observationProof,
  ])
    entry.sha256 = crypto
      .createHash("sha256")
      .update(fs.readFileSync(entry.path))
      .digest("hex");
  // The frozen reader accepted matching undefined build fields. A handoff must
  // carry an actual departing build identity, so this is an intentional refusal.
  assert.equal(
    historical.auditUpgradeApproval(f.approval, dir)?.departingBuildHash,
    undefined,
  );
  assert.throws(() => current.auditUpgradeApproval(f.approval, dir), {
    code: "AUDIT_UPGRADE_PROOF_INVALID",
  });
});
