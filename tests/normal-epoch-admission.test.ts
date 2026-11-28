import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import syntheticClosedScratch from "./fixtures/closed-scratch-artifacts.cjs";

type Pointer = Parameters<typeof syntheticClosedScratch>[1] & {
  quarantinedJobIds: string[];
};
interface State {
  readonly epoch: unknown;
  readonly data: Parameters<
    typeof import("../packages/node-adapters/src/broker-ipc/normal-admission").epochStartupPinned
  >[0]["data"];
  readonly admissionMode: string;
  assertEpoch(): void;
  summary(): { admissionScope: string };
  status(id: string): { state: string };
  submit(request: Record<string, unknown>): { id: string };
  resolve(id: string, owner: string): void;
  pause(value: boolean): void;
  next(): unknown;
  markDispatch(
    id: string,
    value: { rpcCount: number; completedCount: number },
  ): void;
  block(id: string, details: { code: string }): void;
}
const sourceRoot = path.resolve(__dirname, "../..");
const repo = path.resolve(process.env["FMCAD_TEST_RUNTIME"] || sourceRoot);
const runtimeRequire = createRequire(__filename);
const { epochStartupPinned } = runtimeRequire(
  path.join(repo, "src/dist/node-adapters/broker-ipc/normal-admission"),
) as typeof import("../packages/node-adapters/src/broker-ipc/normal-admission");
const isolated = runtimeRequire(
  path.join(repo, "src/queue-isolated-epoch"),
) as {
  openIsolatedEpoch(root: string, options: { recover: false }): State;
  epochAdmission(
    state: State,
    request: Record<string, unknown>,
    clients: Record<string, string>,
  ): void;
};
function fixture(t: TestContext) {
  const base = fs.mkdtempSync(path.join(tmpdir(), "normal-epoch-admission-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const make = runtimeRequire(
    path.join(sourceRoot, "tests/fixtures/current-epoch-upgrade.cjs"),
  ) as (
    base: string,
    repo: string,
  ) => { dir: string; pointer: Pointer; clientId: string };
  const f = make(base, repo);
  f.pointer.restoreActiveCreationId = null;
  const { durable } = runtimeRequire(path.join(repo, "src/queue-instance")) as {
    durable(file: string, value: unknown): void;
  };
  durable(path.join(f.dir, "isolated-admission-epoch.json"), f.pointer);
  const state = isolated.openIsolatedEpoch(f.dir, { recover: false });
  const history = fs.readFileSync(path.join(f.dir, "queue-state.json"));
  const request = (clientId: string, requestId: string) => ({
    kind: "rpc",
    clientId,
    requestId,
    timeoutMs: 1000,
    payload: { jsonrpc: "2.0", id: requestId, method: "ping" },
  });
  return { ...f, state, history, request, durable };
}

test("owner close/restore releases two clients while history remains immutable and unreplayable", (t) => {
  const f = fixture(t);
  const requests = ["client-a", "client-b"].map((clientId, index) =>
    f.request(clientId, "new-" + index),
  );
  for (const request of requests)
    assert.throws(() => isolated.epochAdmission(f.state, request, {}), {
      code: "EPOCH_CLIENT_NOT_GRANTED",
    });
  syntheticClosedScratch(f.dir, f.pointer, repo, "normal-multidocument");
  assert.equal(f.state.admissionMode, "normal-multidocument");
  for (const request of requests) {
    isolated.epochAdmission(f.state, request, {});
    f.state.submit(request);
  }
  assert.equal(f.state.summary().admissionScope, "normal-multidocument");
  assert.throws(() => f.state.assertEpoch(), { code: "EPOCH_CLOSED" });
  assert.throws(
    () => f.state.submit(f.request(f.clientId, "historical-request")),
    { code: "HISTORICAL_REQUEST_QUARANTINED" },
  );
  const historicalJob = f.pointer.quarantinedJobIds[0];
  assert.ok(historicalJob);
  assert.throws(() => f.state.resolve(historicalJob, f.clientId), {
    code: "INSTANCE_HISTORY_QUARANTINED",
  });
  assert.deepEqual(
    fs.readFileSync(path.join(f.dir, "queue-state.json")),
    f.history,
  );
  const reopened = isolated.openIsolatedEpoch(f.dir, { recover: false });
  assert.equal(reopened.admissionMode, "normal-multidocument");
  assert.equal(reopened.status(historicalJob).state, "needs_reconciliation");
});

test("ordinary-mode label without original owner close binding never grants release", (t) => {
  const f = fixture(t);
  const reference = syntheticClosedScratch(f.dir, f.pointer, repo);
  const closed: unknown = JSON.parse(fs.readFileSync(reference.path, "utf8"));
  assert.ok(closed && typeof closed === "object" && !Array.isArray(closed));
  f.durable(reference.path, {
    ...closed,
    admissionMode: "normal-multidocument",
  });
  assert.throws(
    () => isolated.epochAdmission(f.state, f.request("new", "new"), {}),
    { code: "EPOCH_CLOSE_UNPROVEN" },
  );
});

test("current unknown blocks admission even after known owner release", (t) => {
  const f = fixture(t);
  syntheticClosedScratch(f.dir, f.pointer, repo, "normal-multidocument");
  f.state.pause(false);
  const request = f.request("new", "new-unknown");
  const job = f.state.submit(request);
  f.state.next();
  f.state.markDispatch(job.id, { rpcCount: 1, completedCount: 0 });
  f.state.block(job.id, { code: "UNKNOWN_RPC" });
  assert.throws(() => isolated.epochAdmission(f.state, request, {}), {
    code: "EPOCH_RECONCILIATION_REQUIRED",
  });
});

test("FAKE recovery: cold startup retains unresolved work and never treats worker exit as SDK settlement", (t) => {
  const f = fixture(t);
  syntheticClosedScratch(f.dir, f.pointer, repo, "normal-multidocument");
  f.state.pause(false);
  // Retired unknown history alone does not prevent an ordinary runtime update.
  assert.equal(epochStartupPinned(f.state, "old-build", "new-build"), false);
  const job = f.state.submit(f.request("new", "unresolved-sdk-turn"));
  f.state.next();
  f.state.markDispatch(job.id, { rpcCount: 1, completedCount: 0 });
  f.state.block(job.id, { code: "UNKNOWN_RPC" });
  const directory = path.join(f.dir, "jobs", job.id);
  fs.mkdirSync(directory, { recursive: true });
  f.durable(path.join(directory, "worker-result.json"), {
    jobId: job.id,
    code: 1,
    terminal: true,
  });
  const reopened = isolated.openIsolatedEpoch(f.dir, { recover: false });
  const before = JSON.stringify(reopened.data);
  const epoch = JSON.stringify(reopened.epoch);
  // Pinned startup is metadata recovery, not permission to probe or replay.
  assert.equal(epochStartupPinned(reopened, "old-build", "old-build"), true);
  assert.throws(() => epochStartupPinned(reopened, "old-build", "new-build"), {
    code: "EPOCH_BUSY",
  });
  assert.throws(
    () => isolated.epochAdmission(reopened, f.request("new", "next"), {}),
    {
      code: "EPOCH_RECONCILIATION_REQUIRED",
    },
  );
  assert.equal(reopened.status(job.id).state, "needs_reconciliation");
  assert.equal(JSON.stringify(reopened.data), before);
  assert.equal(JSON.stringify(reopened.epoch), epoch);
  assert.deepEqual(
    fs.readFileSync(path.join(f.dir, "queue-state.json")),
    f.history,
  );
});
