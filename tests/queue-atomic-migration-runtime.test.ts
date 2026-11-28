import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Snapshot } from "../src/composition/queue-atomic-migration-types";

type Api = typeof import("../src/composition/queue-atomic-migration-runtime");
const root = path.resolve(__dirname, "../..");
const runtimeFile = path.join(root, "src/queue-atomic-migration-runtime.js");
const runtimeRequire = createRequire(runtimeFile);
const history = path.join(root, "tests/fixtures/history");
const manifest = JSON.parse(
  fs.readFileSync(path.join(history, "manifest.json"), "utf8"),
) as {
  revision: string;
  sourcePath: string;
  file: string;
  sha256: string;
}[];
const source = manifest.find(
  (entry) => entry.sourcePath === "src/queue-atomic-migration-runtime.js",
);
assert.ok(source);
const frozen = fs.readFileSync(path.join(history, source.file), "utf8");
assert.equal(createHash("sha256").update(frozen).digest("hex"), source.sha256);

/** Only external process observations are controlled; actual filesystem guards run. */
function loadApi(
  legacy: boolean,
  state: { live: boolean; observed: unknown[]; directory?: string },
): Api {
  const filename = legacy
    ? runtimeFile
    : path.join(root, "src/dist/composition/queue-atomic-migration-runtime.js");
  const bytes = legacy ? frozen : fs.readFileSync(filename, "utf8");
  const routed = Object.assign(
    (id: string): unknown => {
      if (id === "node:module") return { createRequire: () => routed };
      if (id === "node:child_process")
        return {
          spawn: () =>
            assert.fail("Rejected migration must not launch a process"),
        };
      if (id === "./queue-connection" && state.directory)
        return {
          ...(runtimeRequire(id) as object),
          queueDirectory: () => state.directory,
        };
      if (id === "./queue-instance")
        return {
          ...(runtimeRequire(id) as object),
          priorProcessAlive: () => state.live,
        };
      if (id === "./atomic-workflow-observation")
        return {
          ...(runtimeRequire(id) as object),
          fastenersScope: {
            jobId: "holder",
            requestId: "holder-request",
            reportPath: "/synthetic-report",
          },
        };
      if (id === "./queue-instance-liveness")
        return {
          ...(runtimeRequire(id) as object),
          requireRecoveryProcesses: (...args: unknown[]) => {
            state.observed.push(args);
            return {};
          },
        };
      return runtimeRequire(id) as unknown;
    },
    { resolve: runtimeRequire.resolve },
  );
  const factory = vm.runInThisContext(
    "(function(exports, require, module, __filename, __dirname) {\n" +
      bytes +
      "\n})",
    { filename },
  ) as (
    exports: object,
    require: typeof routed,
    module: { exports: unknown },
    filename: string,
    directory: string,
  ) => void;
  const target: { exports: unknown } = { exports: {} };
  factory(
    target.exports as object,
    routed,
    target,
    filename,
    path.dirname(filename),
  );
  return target.exports as Api;
}
function outcome(action: () => unknown) {
  try {
    return { value: action() };
  } catch (error) {
    const failure = error as Error & { code?: string };
    return { error: failure.message, code: failure.code };
  }
}
function tree(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true })
    .map(String)
    .sort()
    .map((name) => {
      const file = path.join(root, name);
      return fs.statSync(file).isDirectory()
        ? name + "/"
        : name +
            ":" +
            createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    });
}

test("typed runtime preserves closed-gate admission and refuses foreign migration claims", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "migration-runtime-gate-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const marker = {
    kind: "atomic-owner-migration",
    nonce: "owned",
    audit: directory,
    clientId: "owner",
  };
  for (const name of ["atomic-migration.lock", "recovery.lock"])
    fs.writeFileSync(path.join(directory, name), JSON.stringify(marker));
  const before = tree(directory);
  const states = [true, false].map((legacy) => {
    const state = { live: false, observed: [] as unknown[] },
      api = loadApi(legacy, state);
    return {
      admission: [
        "submit",
        "observe-atomic",
        "audit-atomic",
        "pause",
        "console-restart",
        "queue-summary",
        "find-request",
        "result",
      ].map((action) =>
        outcome(() => api.assertMigrationAdmission(directory, action)),
      ),
      claim: outcome(() =>
        api.claimMigratedBroker(
          directory,
          { nonce: "new", pid: 123, birth: "new-birth" },
          "foreign",
          "build",
        ),
      ),
      observations: state.observed,
    };
  });
  assert.deepEqual(states[1], states[0]);
  assert.deepEqual(
    states[0]?.admission.slice(0, 5).map((x) => x.code),
    Array(5).fill("MIGRATION_IN_PROGRESS"),
  );
  assert.equal(states[0]?.claim.code, "RECOVERY_IN_PROGRESS");
  assert.deepEqual(tree(directory), before);
});

test("typed runtime retains original receipt binding, ordering and fail-closed worker observations", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "migration-runtime-receipts-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const jobs = path.join(directory, "jobs", "holder");
  fs.mkdirSync(jobs, { recursive: true });
  const instance = { pid: 123, birth: "original-process", version: "v1" };
  const binding = {
    jobId: "holder",
    rpcId: "rpc",
    requestHash: "request",
    buildHash: "original-build",
    sourceHash: "source",
  };
  const receipt = path.join(jobs, "turn-receipt.json"),
    recordFile = path.join(jobs, "rpc-0001.json");
  const validReceipt = {
    ...binding,
    instance,
    terminal: true,
    outcome: "succeeded",
  };
  const validRecord = { binding, instance, receipt };
  const snapshot = {
    state: { jobs: { holder: { id: "holder", dispatch: { rpcCount: 1 } } } },
    identity: { buildHash: "original-build", instance },
  } as unknown as Snapshot;
  const cases = [
    "valid",
    "wrong-job",
    "wrong-instance",
    "nonterminal",
    "unknown-outcome",
    "missing-turn",
    "foreign-path",
    "worker-missing",
    "worker-live",
    "adapter-unknown",
  ] as const;
  for (const fault of cases) {
    for (const name of fs.readdirSync(jobs))
      fs.unlinkSync(path.join(jobs, name));
    fs.writeFileSync(
      receipt,
      JSON.stringify({
        ...validReceipt,
        ...(fault === "wrong-job" ? { jobId: "foreign" } : {}),
        ...(fault === "wrong-instance"
          ? { instance: { ...instance, birth: "foreign" } }
          : {}),
        ...(fault === "nonterminal" ? { terminal: false } : {}),
        ...(fault === "unknown-outcome" ? { outcome: "unknown" } : {}),
      }),
    );
    fs.writeFileSync(
      recordFile,
      JSON.stringify({
        ...validRecord,
        ...(fault === "foreign-path"
          ? { receipt: path.join(directory, "foreign.json") }
          : {}),
      }),
    );
    fs.writeFileSync(
      path.join(directory, "foreign.json"),
      JSON.stringify(validReceipt),
    );
    if (fault === "worker-missing")
      fs.writeFileSync(path.join(jobs, "worker-start.json"), "{}");
    if (fault === "worker-live")
      fs.writeFileSync(
        path.join(jobs, "worker-identity.json"),
        JSON.stringify({ pid: 456, birth: "live" }),
      );
    if (fault === "adapter-unknown")
      fs.writeFileSync(
        path.join(jobs, "adapter-outcome.json"),
        JSON.stringify({
          jobId: "holder",
          buildHash: "original-build",
          unknown: true,
        }),
      );
    const input = structuredClone(snapshot);
    input.state.jobs["holder"]!.dispatch.rpcCount =
      fault === "missing-turn" ? 2 : 1;
    const before = tree(directory);
    const observations = [true, false].map((legacy) => {
      const state = {
          live: fault === "worker-live",
          observed: [] as unknown[],
        },
        api = loadApi(legacy, state);
      return {
        result: outcome(() => api.validateOriginalEvidence(directory, input)),
        processes: state.observed,
      };
    });
    assert.deepEqual(observations[1], observations[0], fault);
    if (fault === "valid")
      assert.equal(observations[0]?.result.error, undefined);
    else assert.ok(observations[0]?.result.error, fault);
    assert.deepEqual(
      tree(directory),
      before,
      fault + " must not change evidence",
    );
  }
});

test("typed approval retains qualification rejection before preparing, stopping or installing", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "migration-runtime-approval-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const candidateRoot = path.join(directory, "candidate"),
    installRoot = path.join(directory, "installed");
  fs.mkdirSync(path.join(candidateRoot, "src"), { recursive: true });
  fs.mkdirSync(installRoot);
  const moduleFile = path.join(candidateRoot, "src/queue-admission.js");
  fs.writeFileSync(moduleFile, "module.exports = {};\n");
  const { buildHash } = runtimeRequire("./queue-instance") as {
    buildHash(root: string): string;
  };
  const hash = (file: string) =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const build = buildHash(candidateRoot),
    sourceCommit = "a".repeat(40),
    qualification = path.join(directory, "qualification.json"),
    file = path.join(directory, "approval.json");
  fs.writeFileSync(
    path.join(candidateRoot, "runtime-build.json"),
    JSON.stringify({ fingerprint: build }),
  );
  fs.writeFileSync(
    qualification,
    JSON.stringify({
      sourceCommit,
      buildHash: build,
      productionAdmission: true,
      passed: true,
    }),
  );
  const approval = {
    version: 1,
    sourceCommit,
    buildHash: build,
    candidateRoot,
    installRoot,
    admissionModuleSha256: hash(moduleFile),
    checkerFingerprint: "b".repeat(64),
    qualification: { path: qualification, sha256: hash(qualification) },
  };
  for (const changedBuild of [false, true]) {
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...approval,
        ...(changedBuild ? { buildHash: "c".repeat(64) } : {}),
      }),
    );
    const before = tree(directory),
      results = [];
    for (const legacy of [true, false]) {
      const api = loadApi(legacy, { live: false, observed: [] });
      let prepared = 0;
      try {
        await api.approvedCandidate(file, async () => {
          prepared++;
          throw Error("unexpected preparation");
        });
        assert.fail("Approval unexpectedly passed");
      } catch (error) {
        const failure = error as Error & { code?: string };
        results.push({
          code: failure.code,
          message: failure.message,
          prepared,
        });
      }
    }
    assert.deepEqual(results[1], results[0]);
    assert.equal(
      results[0]?.code,
      changedBuild ? "BUILD_CHANGED" : "PYTHON_ADMISSION_UNAVAILABLE",
    );
    assert.equal(results[0]?.prepared, 0);
    assert.deepEqual(tree(directory), before);
  }
});

test("production factory retains preflight request and competing lifecycle fences", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "migration-runtime-preflight-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const guard of ["fusion-reset.lock", "autostart.lock"]) {
    fs.writeFileSync(path.join(directory, guard), "{}");
    const before = tree(directory),
      results = [];
    for (const legacy of [true, false]) {
      const api = loadApi(legacy, { live: false, observed: [], directory });
      const migrate = api.createProductionMigrator(
        {
          auth: { clientId: "owner", clientToken: "secret" },
          call: async () =>
            assert.fail("Lifecycle fence must precede broker calls"),
        },
        {},
      );
      const row = [];
      for (const jobId of ["foreign", "holder"]) {
        try {
          await migrate.preflight("approval", "stable-request", jobId);
          assert.fail("Preflight unexpectedly passed");
        } catch (error) {
          const failure = error as Error & { code?: string };
          row.push({ message: failure.message, code: failure.code });
        }
      }
      results.push(row);
    }
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(
      results[0]?.map((row) => row.code),
      ["INVALID_REQUEST", "MIGRATION_COMPETING_LIFECYCLE"],
    );
    assert.deepEqual(tree(directory), before);
    fs.unlinkSync(path.join(directory, guard));
  }
});
