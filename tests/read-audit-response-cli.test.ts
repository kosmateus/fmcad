interface AuditFixture {
  files: import("../src/queue-audit-response-proof").AuditResponseManifest;
  records: Record<string, Record<string, unknown>>;
  migrationAudit: string;
  key: { requestId: string };
}
import { createRequire } from "node:module";
const root = process.cwd();
const load = createRequire(
  path.join(root, "tests", "read-audit-response-cli.test.js"),
);
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const { durable, hash } = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { fileHash } = load(
  "../src/queue-atomic-migration-files",
) as typeof import("../src/queue-atomic-migration-files");
const frozen = process.env["FMCAD_TEST_LEGACY_843_RUNTIME"];
test(
  "file-only reader authenticates original existing credentials, writes only a derived proof, and refuses a foreign owner",
  {
    skip:
      !frozen &&
      "Set FMCAD_TEST_LEGACY_843_RUNTIME to the exact qualified 843 runtime for installed compatibility testing",
  },
  (t) => {
    assert.ok(frozen);
    const base = fs.mkdtempSync("/tmp/opencode/audit-reader-owner-");
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const dir = path.join(base, "state/fmcad/queue");
    fs.mkdirSync(dir, { recursive: true });
    const scope = {
      ...(
        load(
          "../src/atomic-workflow-observation",
        ) as typeof import("../src/composition/library-atomic-workflow-observation")
      ).fastenersScope,
      observationJobId: "3627db2e-0b9d-4e4f-927f-20cb45deae74",
    };
    const f = (
      load("./fixtures/audit-response.cjs") as (
        ...args: unknown[]
      ) => AuditFixture
    )(
      dir,
      scope,
      {
        commandId: "fmcad_atomic_fixture",
        resolvedIdentity: {
          name: "Historical fixture",
          creationId: "old",
          fileId: null,
        },
      },
      { pid: 20, birth: "selected", version: "2706" },
      { pid: 10, birth: "historical", version: "2706" },
      { nonce: "old-owner" },
    );
    const token = "a".repeat(64),
      tokenHash = hash(token);
    f.records["migrationIntent"]!["ownerTokenHash"] = tokenHash;
    durable(f.files.migrationIntent.path, f.records["migrationIntent"]!);
    fs.mkdirSync(path.join(dir, "client-credentials"));
    durable(
      path.join(dir, "client-credentials", hash("original-owner") + ".json"),
      { clientId: "original-owner", clientToken: token },
      true,
    );
    durable(
      path.join(dir, "client-credentials", hash("foreign") + ".json"),
      { clientId: "foreign", clientToken: "b".repeat(64) },
      true,
    );
    durable(
      path.join(dir, "clients.json"),
      { "original-owner": tokenHash, foreign: hash("b".repeat(64)) },
      true,
    );
    durable(
      path.join(dir, "queue-state.json"),
      {
        jobs: Object.fromEntries(
          [scope.jobId, scope.observationJobId].map((id) => [
            id,
            { clientId: "original-owner", request: { ownerToken: tokenHash } },
          ]),
        ),
      },
      true,
    );
    const before = Object.fromEntries(
      Object.entries(f.files).map(([name, entry]) => [
        name,
        fileHash(entry.path).sha256,
      ]),
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: path.join(base, "home"),
      XDG_CONFIG_HOME: path.join(base, "config"),
      XDG_STATE_HOME: path.join(base, "state"),
      XDG_CACHE_HOME: path.join(base, "cache"),
      FMCAD_CLIENT: "original-owner",
    };
    delete env["FMCAD_CONFIG"];
    const output = path.join(base, "derived/proof.json");
    const args = [
      path.join(root, "scripts/read-audit-response-proof.cjs"),
      "--runtime",
      frozen,
      "--migration-audit",
      f.migrationAudit,
      "--request-id",
      f.key.requestId,
      "--output",
      output,
    ];
    const success = spawnSync(process.execPath, args, {
      env,
      cwd: base,
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(success.status, 0, success.stderr);
    const report = JSON.parse(fs.readFileSync(output, "utf8")) as {
      writerAuthenticated: boolean;
      writerClientId: string;
      sdkRequestsSent: number;
      facts: { available: boolean };
      epochEligible: boolean;
    };
    assert.equal(report.writerAuthenticated, true);
    assert.equal(report.writerClientId, "original-owner");
    assert.equal(report.sdkRequestsSent, 0);
    assert.equal(report.facts.available, false);
    assert.equal(report.epochEligible, false);
    const foreign = spawnSync(
      process.execPath,
      [...args.slice(0, -1), path.join(base, "foreign-proof.json")],
      {
        env: { ...env, FMCAD_CLIENT: "foreign" },
        cwd: base,
        encoding: "utf8",
        timeout: 30000,
      },
    );
    assert.notEqual(foreign.status, 0);
    assert.match(foreign.stderr, /NOT_OWNER/);
    assert.equal(fs.existsSync(path.join(base, "foreign-proof.json")), false);
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(f.files).map(([name, entry]) => [
          name,
          fileHash(entry.path).sha256,
        ]),
      ),
      before,
    );
    assert.equal(
      fs.existsSync(path.join(dir, "broker.sock")),
      false,
      "No IPC/SDK server was needed or started",
    );
  },
);
