import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

interface Key {
  jobId: string;
  observationJobId: string;
  requestId: string;
  clientId: string;
}
interface Result extends Key {
  kind: string;
  status: string;
  summary: unknown;
  activation?: Key;
}
interface Prior {
  key: Key;
  identity: unknown;
  binding: unknown;
}
interface Controller {
  handle(message: Omit<Key, "clientId">, clientId: string): Promise<Result>;
}
interface Ports {
  jobDirectory(jobId: string): string;
  assertOwner(job: string, observer: string, client: string): void;
  parseSummary(reply: unknown, identity: unknown, binding: unknown): unknown;
  publishComplete?(result: Result, prior: Prior, receipt: string): Promise<Key>;
  inspect(): never;
}
interface AuditModule {
  createRecoveryAudit(ports: Ports): Controller;
}
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const current = load("./src/queue-atomic-recovery-audit") as AuditModule;
const retained = (
  load("./tests/fixtures/historical-module.cjs") as (
    revision: string,
    source: string,
  ) => AuditModule
)(
  "5102259463ba490b942d4d94dc8db959bfcfbe0e",
  "src/queue-atomic-recovery-audit.js",
);
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t: TestContext, implementation: AuditModule, failA = false) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "audit-publication-"),
  );
  const hold = deferred();
  t.after(() => {
    hold.resolve();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const keys: Key[] = ["a", "b"].map((id) => ({
    jobId: id,
    observationJobId: "observer-" + id,
    requestId: "request-" + id,
    clientId: "owner-" + id,
  }));
  const files: string[] = [];
  for (const key of keys) {
    const dir = path.join(directory, key.jobId, "atomic-recovery-audit");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const values = {
      "intent.json": {
        version: 1,
        key,
        identity: { document: key.jobId },
        binding: { owner: key.clientId },
      },
      "result.json": {
        kind: "atomic-recovery-audit",
        ...key,
        status: "complete",
        summary: { document: key.jobId },
        nativeOutcome: "unknown",
        modelValidation: "not_performed",
        rollbackVerification: "not_performed",
        sdkRequestsSent: 0,
      },
    };
    for (const [name, value] of Object.entries(values)) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
      files.push(file);
    }
  }
  const before = files.map((file) => fs.readFileSync(file));
  const publications: string[] = [];
  let shouldFail = failA;
  const controller = implementation.createRecoveryAudit({
    jobDirectory: (id) => path.join(directory, id),
    assertOwner(job, observer, client) {
      assert.ok(
        keys.some(
          (k) =>
            k.jobId === job &&
            k.observationJobId === observer &&
            k.clientId === client,
        ),
        "exact owned audit",
      );
    },
    parseSummary(reply, identity, binding) {
      assert.ok(reply);
      assert.ok(identity);
      assert.ok(binding);
      return {};
    },
    async publishComplete(result, prior, receipt) {
      assert.equal(
        receipt,
        path.join(directory, result.jobId, result.kind, "result.json"),
      );
      assert.equal(result.requestId, prior.key.requestId);
      publications.push(result.jobId);
      await hold.promise;
      if (shouldFail && result.jobId === "a")
        throw new Error("publication-a-failed");
      return prior.key;
    },
    inspect() {
      assert.fail("Retained results cannot start another SDK operation");
    },
  });
  function poll(index: number) {
    const key = keys[index];
    assert.ok(key);
    const { clientId, ...message } = key;
    return controller.handle(message, clientId);
  }
  return {
    controller,
    keys,
    publications,
    hold,
    poll,
    retry() {
      shouldFail = false;
    },
    unchanged() {
      assert.deepEqual(
        files.map((file) => fs.readFileSync(file)),
        before,
      );
    },
  };
}
for (const [name, implementation] of [
  ["retained", retained],
  ["current", current],
] as const) {
  test(`${name}: eight polls for the same receipt join one publication`, async (t) => {
    const f = fixture(t, implementation);
    const polls = Array.from({ length: 8 }, () => f.poll(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(f.publications, ["a"]);
    f.hold.resolve();
    const results = await Promise.all(polls);
    for (const result of results)
      assert.deepEqual(result.activation, f.keys[0]);
    f.unchanged();
  });
  test(`${name}: two owners' concurrent receipt polls retain their own activation`, async (t) => {
    const f = fixture(t, implementation);
    const polls = Array.from({ length: 10 }, (_, i) => f.poll(i % 2));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(f.publications, name === "retained" ? ["a"] : ["a", "b"]);
    f.hold.resolve();
    const results = await Promise.all(polls);
    results.forEach((result, i) => {
      assert.equal(result.jobId, i % 2 ? "b" : "a");
      assert.deepEqual(
        result.activation,
        f.keys[name === "retained" ? 0 : i % 2],
      );
    });
    f.unchanged();
  });
  test(`${name}: one owner's failed publication cannot reject another owner's completed result`, async (t) => {
    const f = fixture(t, implementation, true);
    const results = Promise.allSettled([f.poll(0), f.poll(1)]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.hold.resolve();
    const [a, b] = await results;
    assert.equal(a?.status, "rejected");
    assert.equal(b?.status, name === "retained" ? "rejected" : "fulfilled");
    if (b?.status === "fulfilled")
      assert.deepEqual(b.value.activation, f.keys[1]);
    f.unchanged();
  });
  test(`${name}: failed local publication can retry original evidence without replay`, async (t) => {
    const f = fixture(t, implementation, true);
    f.hold.resolve();
    await assert.rejects(f.poll(0), /publication-a-failed/);
    f.retry();
    assert.deepEqual((await f.poll(0)).activation, f.keys[0]);
    assert.deepEqual(f.publications, ["a", "a"]);
    f.unchanged();
  });
  test(`${name}: a foreign owner cannot join a pending owned publication`, async (t) => {
    const f = fixture(t, implementation),
      key = f.keys[0];
    assert.ok(key);
    const message = {
      jobId: key.jobId,
      observationJobId: key.observationJobId,
      requestId: key.requestId,
    };
    const pending = f.poll(0);
    await assert.rejects(
      f.controller.handle(message, "owner-b"),
      /exact owned audit/,
    );
    f.hold.resolve();
    assert.deepEqual((await pending).activation, key);
    assert.deepEqual(f.publications, ["a"]);
    f.unchanged();
  });
}
