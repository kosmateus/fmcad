import type { RecoveryAuditPorts } from "../packages/node-adapters/src/execution/recovery-audit";
import { createRequire } from "node:module";
import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const api = load("./src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { savedAuditKind, savedAuditLegacyKind, assertSavedAuditPathBudget } =
  load(
    "./src/queue-saved-audit-path",
  ) as typeof import("../packages/node-adapters/src/persistence/saved-audit-path");
const { createRecoveryAudit } = load("./src/queue-atomic-recovery-audit") as {
  createRecoveryAudit(
    options: Partial<RecoveryAuditPorts>,
  ): ReturnType<
    typeof import("../src/queue-atomic-recovery-audit").createRecoveryAudit
  >;
};

test("saved audit layout includes the existing atomic UUID temporary suffix in the Windows path budget", () => {
  const root =
    "\\\\wsl$\\Ubuntu\\home\\test-user\\.local\\state\\fmcad\\queue\\epoch-successions\\" +
    "a".repeat(64);
  const request = "one-full-original-destination-request";
  const old = path.join(root, savedAuditLegacyKind("dp-", request));
  assert.throws(() => assertSavedAuditPathBudget(old), {
    code: "SAVED_AUDIT_PATH_TOO_LONG",
  });
  const shorter = assertSavedAuditPathBudget(
    path.join(root, savedAuditKind("dp-", request)),
  );
  assert.ok(shorter.atomicTempLength <= 259);
  assert.equal(savedAuditKind("dp-", request).length, 19);
  assert.notEqual(
    savedAuditKind("dp-", request),
    savedAuditKind("sr-", request),
  );
});

test("a shortened directory collision still fails the full immutable request key before SDK", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "saved-audit-collision-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kind = "dp-same-locator",
    dir = path.join(root, kind);
  fs.mkdirSync(dir);
  api.durable(
    path.join(dir, "intent.json"),
    {
      key: {
        jobId: "real-parent",
        requestId: "original-full-id",
        clientId: "owner",
      },
    },
    true,
  );
  const control = createRecoveryAudit({
    kind,
    priorObservationRequired: false,
    jobDirectory: () => root,
    assertOwner() {},
    inspect() {
      assert.fail("Collision must reject before preparing or sending SDK");
    },
  });
  await assert.rejects(
    control.handle(
      {
        action: "inspect",
        jobId: "real-parent",
        requestId: "different-full-id",
      },
      "owner",
    ),
    { code: "AUDIT_ALREADY_REQUESTED" },
  );
});
