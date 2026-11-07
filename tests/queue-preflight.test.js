"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  LEGACY_BUSY_BUILD,
  legacyBusyEvidence,
} = require("../src/queue-preflight");

test("legacy FUSION_BUSY proof is scoped to its exact build, instance and zero-RPC record", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-legacy-preflight-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const instance = { pid: 91, birth: "fixture:91", version: "attested" };
  const job = {
    id: "legacy-job",
    requestId: "request",
    clientId: "client",
    hash: "request-hash",
    state: "needs_reconciliation",
    details: { reason: "FUSION_BUSY" },
    dispatch: { rpcCount: 0, completedCount: 0 },
  };
  const data = {
    active: job.id,
    blocked: { id: job.id, reason: "FUSION_BUSY" },
    jobs: { [job.id]: job },
  };
  const start = path.join(directory, "preflight-start.json");
  fs.writeFileSync(
    start,
    JSON.stringify({ jobId: job.id, buildHash: LEGACY_BUSY_BUILD, instance }),
  );

  const evidence = legacyBusyEvidence(
    data,
    instance,
    LEGACY_BUSY_BUILD,
    directory,
  );
  assert.equal(evidence.method, "attested-legacy-control-flow");
  assert.equal(evidence.jobId, job.id);
  assert.equal(
    evidence.preflightStartSHA256,
    require("../src/queue-instance").hash(fs.readFileSync(start)),
  );
  assert.equal(evidence.probeCompleted, true);
  assert.equal(evidence.observedIdle, false);
  assert.equal(evidence.userScriptSubmitted, false);
  assert.equal(evidence.rpcCount, 0);

  assert.equal(
    legacyBusyEvidence(data, instance, "different-build", directory),
    null,
  );
  assert.equal(
    legacyBusyEvidence(
      data,
      { ...instance, pid: 92 },
      LEGACY_BUSY_BUILD,
      directory,
    ),
    null,
  );
  assert.equal(
    legacyBusyEvidence(
      { ...data, blocked: { ...data.blocked, reason: "OTHER" } },
      instance,
      LEGACY_BUSY_BUILD,
      directory,
    ),
    null,
  );
  assert.equal(
    legacyBusyEvidence(
      {
        ...data,
        jobs: {
          [job.id]: { ...job, dispatch: { rpcCount: 1, completedCount: 0 } },
        },
      },
      instance,
      LEGACY_BUSY_BUILD,
      directory,
    ),
    null,
  );

  fs.writeFileSync(path.join(directory, "unrelated.json"), "{}");
  assert.equal(
    legacyBusyEvidence(data, instance, LEGACY_BUSY_BUILD, directory),
    null,
  );
});
