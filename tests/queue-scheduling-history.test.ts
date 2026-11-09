import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { QueueDomain } from "../packages/core/src/domain/queue";
import type { QueueRequest } from "../packages/core/src/domain/queue-model";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
) => unknown;
type State = Pick<
  QueueDomain,
  | "submit"
  | "next"
  | "finish"
  | "release"
  | "status"
  | "summary"
  | "pause"
  | "block"
  | "resolve"
>;
const old = historical(
  "a26222ff617b0e9597b2a91b50474bdca8d0a0ce",
  "src/queue-state.js",
) as {
  QueueState: new (directory: string, options: { now(): number }) => State;
};
const current = load("./src/dist/core/domain/queue") as {
  QueueDomain: typeof QueueDomain;
};

function fixture(t: TestContext, version: "historical" | "current") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "queue-history-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let time = 1000;
  const state: State =
    version === "historical"
      ? new old.QueueState(directory, { now: () => time })
      : new current.QueueDomain({
          now: () => time,
          newId: randomUUID,
          hash: (value) => createHash("sha256").update(value).digest("hex"),
        });
  const submit = (clientId: string, extra: Partial<QueueRequest> = {}) => {
    const submitted = state.submit({
      requestId: randomUUID(),
      clientId,
      kind: "rpc",
      timeoutMs: 1000,
      payload: { jsonrpc: "2.0", id: 1, method: "ping" },
      ...extra,
    });
    assert.ok(typeof submitted["id"] === "string");
    return { id: submitted["id"] };
  };
  const next = () => {
    const job = state.next();
    assert.ok(job);
    return job;
  };
  return {
    state,
    submit,
    next,
    advance: (value: number) => {
      time += value;
    },
  };
}

for (const version of ["historical", "current"] as const) {
  test(`${version}: only the owner can release a settled exclusive sequence`, (t) => {
    const { state, submit, next } = fixture(t, version);
    submit("a", {
      ownerToken: "private-a",
      sequence: { action: "begin", mode: "exclusive" },
    });
    const a = next();
    state.finish(a.id);
    const b = submit("b");
    assert.equal(state.next(), null);
    assert.throws(() => state.release(a.sequenceId!, "b"), {
      code: "NOT_OWNER",
    });
    state.release(a.sequenceId!, "a");
    assert.equal(next().id, b.id);
    state.finish(b.id);
    assert.throws(
      () =>
        submit("a", {
          ownerToken: "private-a",
          sequence: { action: "continue", id: a.sequenceId! },
        }),
      { code: "SEQUENCE_MISMATCH" },
    );
    assert.throws(() => submit("a", { expectedRevision: 0 }), {
      code: "STALE_REVISION",
    });
  });

  test(`${version}: dependent steps keep the SDK lane until their sequence ends`, (t) => {
    const { state, submit, next } = fixture(t, version);
    submit("a", { sequence: { action: "begin", mode: "exclusive" } });
    const a = next(),
      b = submit("b");
    assert.equal(state.next(), null);
    assert.throws(() => state.release(a.sequenceId!, "a"), {
      code: "QUEUE_BUSY",
    });
    state.finish(a.id);
    const last = submit("a", {
      sequence: { action: "end", id: a.sequenceId! },
    });
    assert.equal(next().id, last.id);
    state.finish(last.id);
    assert.equal(state.summary().lease, null);
    assert.equal(next().id, b.id);
  });

  test(`${version}: administrative pause retains unknown ownership and queued deadlines`, (t) => {
    const { state, submit, next, advance } = fixture(t, version);
    submit("a", { sequence: { action: "begin", mode: "exclusive" } });
    const a = next();
    state.block(a.id, "unknown remote outcome");
    const b = submit("b", { queueTimeoutMs: 100 });
    state.pause(true);
    advance(1000);
    assert.equal(state.next(), null);
    assert.equal(state.status(b.id)["state"], "queued");
    assert.equal(state.summary().blocked?.id, a.id);
    assert.equal(state.summary().lease?.id, a.sequenceId);
    assert.throws(() => state.release(a.sequenceId!, "a"), {
      code: "QUEUE_BUSY",
    });
    state.resolve(a.id, { state: "failed", code: "RECONCILED" });
    assert.equal(state.next(), null);
    state.pause(false);
    assert.equal(next().id, b.id);
  });
}
