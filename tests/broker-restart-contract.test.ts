import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

type Value = Record<string, unknown>;
interface ProcessPort {
  events: Value[];
  exit: Promise<{ code: number | null; signal: string | null }>;
  event(name: string, tag?: string): Promise<Value>;
  call(action: string, values?: Value): Promise<Value>;
  kill(): Promise<unknown>;
}
interface Fixture {
  dir: string;
  server: ProcessPort;
  a: ProcessPort;
  b: ProcessPort;
  broker(mode?: string, expectReady?: boolean): Promise<ProcessPort>;
}
const load = createRequire(__filename);
const { fixture } = load(
  path.resolve(
    __dirname,
    "../../tests/fixtures/broker-refactor-process/fixture.cjs",
  ),
) as { fixture(t: unknown, crash?: string): Promise<Fixture> };
function object(value: unknown): Value {
  assert.ok(value && typeof value === "object");
  return value as Value;
}
function snapshot(dir: string): Value {
  return JSON.parse(
    fs.readFileSync(path.join(dir, "queue-state.json"), "utf8"),
  ) as Value;
}

test(
  "a rejected runtime configuration leaves no new owner or probe and can reopen after correction",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    await f.server.kill();
    const identityFile = path.join(f.dir, "instance.json");
    const original = fs.readFileSync(identityFile);
    const rejectedIdentity = {
      ...object(JSON.parse(original.toString("utf8")) as unknown),
      configHash: "foreign-runtime-configuration",
    };
    const rejectedBytes = JSON.stringify(rejectedIdentity);
    fs.writeFileSync(identityFile, rejectedBytes);
    const stateBefore = fs.readFileSync(path.join(f.dir, "queue-state.json"));

    const refused = await f.broker("none", false);
    const failure = await refused.event("startup-failed");
    assert.equal(failure["code"], "CONFIG_CHANGED");
    assert.equal(failure["sends"], 0);
    assert.equal(failure["active"], 0);
    assert.equal(failure["maximum"], 0, "not even the startup probe was sent");
    assert.equal((await refused.exit).code, 1);
    assert.equal(fs.existsSync(path.join(f.dir, "broker.lock")), false);
    assert.equal(fs.readFileSync(identityFile, "utf8"), rejectedBytes);
    assert.deepEqual(
      fs.readFileSync(path.join(f.dir, "queue-state.json")),
      stateBefore,
    );

    fs.writeFileSync(identityFile, original);
    const corrected = await f.broker();
    assert.equal((await corrected.call("counts"))["sends"], 0);
    assert.ok(fs.existsSync(path.join(f.dir, "broker.lock")));
  },
);

test(
  "crash after durable admission before ACK preserves the accepted request identity",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, "admission");
    // Attach rejection immediately: the original ACK is deliberately never sent.
    const lostAck = f.a.call("submit").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    assert.equal((await f.server.exit).code, 86);
    const jobs = Object.values(object(snapshot(f.dir)["jobs"])).map(object);
    assert.equal(jobs.length, 1);
    const accepted = jobs[0]!;
    assert.equal(accepted["requestId"], "request-A");
    assert.equal(accepted["clientId"], "owner-A");
    assert.ok(
      "error" in (await lostAck),
      "no ACK was published for the durable admission",
    );
    const restarted = await f.broker();
    const lookup = await f.a.call("lookup");
    assert.equal(object(lookup["job"] ?? lookup)["id"], accepted["id"]);
    assert.equal((await f.a.call("submit"))["id"], accepted["id"]);
    assert.equal((await restarted.call("counts"))["sends"], 0);
  },
);

test(
  "admission commit failure leaves a pending snapshot and restart refuses before any physical call",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, "commit-failure");
    await assert.rejects(f.a.call("submit"), { code: "STORAGE_UNAVAILABLE" });
    assert.equal(
      fs.existsSync(path.join(f.dir, "queue-state.pending.json")),
      true,
    );
    assert.equal((await f.server.call("counts"))["sends"], 0);
    await f.server.kill();
    const restarted = await f.broker("none", false);
    const failure = await restarted.event("startup-failed");
    assert.equal(failure["code"], "STORAGE_UNAVAILABLE");
    assert.equal(failure["sends"], 0);
    assert.equal(
      failure["maximum"],
      0,
      "even a startup probe must not run through ambiguous persistence",
    );
    assert.equal((await restarted.exit).code, 1);
    assert.equal(
      fs.existsSync(path.join(f.dir, "queue-state.pending.json")),
      true,
    );
  },
);

for (const boundary of ["dispatch", "postflight"] as const) {
  test(
    `abrupt ${boundary} restart retains UNKNOWN and never dispatches queued owner B without original evidence`,
    { timeout: 60000 },
    async (t) => {
      const f = await fixture(t, boundary);
      const jobA = await f.a.call("submit");
      const jobB = await f.b.call("submit");
      await Promise.all([
        f.server.event("preparing", "A"),
        f.server.event("preparing", "B"),
      ]);
      await f.server.call("release-prepare", { tag: "A" });
      await f.server.event("physical", "A");
      await f.server.call("release-prepare", { tag: "B" });
      let postflight: Value | undefined;
      if (boundary === "postflight") {
        await f.server.call("release-physical", { tag: "A" });
        postflight = await f.server.event("postflight");
      }
      const before = object(
        object(snapshot(f.dir)["jobs"])[String(jobA["id"])],
      );
      assert.equal(before["requestId"], "request-A");
      const jobDirectory = path.join(f.dir, "jobs", String(jobA["id"]));
      const journal = fs
        .readdirSync(jobDirectory)
        .filter(
          (name) => /^rpc-.*\.json$/.test(name) && name !== "rpc-result.json",
        );
      const journalBytes = journal.map((name) =>
        fs.readFileSync(path.join(jobDirectory, name), "utf8"),
      );
      assert.ok(
        journal.length > 0,
        "dispatch intent is durable before the physical boundary",
      );
      if (boundary === "postflight")
        assert.ok(
          journal.some((name) => {
            const record = JSON.parse(
              fs.readFileSync(path.join(jobDirectory, name), "utf8"),
            ) as Value;
            return record["terminal"] === true;
          }),
          "the main physical terminal result exists before the held postflight",
        );
      await f.server.kill();
      const restarted = await f.broker();
      const resultA = await f.a.call("result", { jobId: jobA["id"] });
      const restored = object(resultA["job"]);
      const restoredSnapshot = object(
        object(snapshot(f.dir)["jobs"])[String(jobA["id"])],
      );
      for (const key of [
        "id",
        "requestId",
        "clientId",
        "request",
        "dispatch",
        "hash",
      ])
        assert.deepEqual(
          restoredSnapshot[key],
          before[key],
          `persisted ${key}`,
        );
      for (const key of ["id", "requestId", "clientId"])
        assert.deepEqual(restored[key], before[key], `retained ${key}`);
      for (const key of ["dispatchCount", "rpcCount", "completedCount"])
        assert.equal(
          object(restored["dispatch"])[key],
          object(before["dispatch"])[key],
          key,
        );
      assert.equal(restored["state"], "needs_reconciliation");
      assert.ok(
        Number(object(restored["dispatch"])["rpcCount"]) > 0,
        "UNKNOWN retains the original submitted-mutation evidence, not a fabricated not-started outcome",
      );
      assert.deepEqual(
        journal.map((name) =>
          fs.readFileSync(path.join(jobDirectory, name), "utf8"),
        ),
        journalBytes,
      );
      assert.equal((await f.a.call("submit"))["id"], jobA["id"]);
      await assert.rejects(f.b.call("result", { jobId: jobA["id"] }), {
        code: "NOT_OWNER",
      });
      const interruptedB = object(
        (await f.b.call("result", { jobId: jobB["id"] }))["job"],
      );
      assert.equal(interruptedB["state"], "failed");
      assert.equal(interruptedB["code"], "LOCAL_WORKER_INTERRUPTED");
      assert.equal((await restarted.call("counts"))["sends"], 0);
      assert.equal(
        (await restarted.call("counts"))["calls"],
        0,
        "restart must not issue even a new observation before original evidence is complete",
      );
      const queuedB = await f.b.call("submit", {
        requestId: "request-B-after-restart",
      });
      await restarted.event("preparing", "B");
      await restarted.call("release-prepare", { tag: "B" });
      const waitingB = await restarted.call("wait-ready", {
        jobId: queuedB["id"],
      });
      assert.equal(waitingB["id"], queuedB["id"]);
      assert.equal(waitingB["clientId"], "owner-B");
      assert.equal(waitingB["requestId"], "request-B-after-restart");
      assert.equal(waitingB["state"], "queued");
      assert.equal(typeof waitingB["sdkReadyAt"], "number");
      assert.equal(
        (await restarted.call("counts"))["calls"],
        0,
        "a new independent producer reaches its SDK request but cannot pass the restored hold",
      );
      await assert.rejects(f.a.call("reconcile", { jobId: jobA["id"] }), {
        code: "RECEIPT_UNAVAILABLE",
      });
      assert.equal((await restarted.call("counts"))["calls"], 0);

      if (postflight) {
        const entries = postflight["entries"] as Array<{
          file: string;
          value: Value;
        }>;
        assert.equal(entries.length, 1);
        const entry = entries[0]!;
        for (const [name, change] of [
          ["owner", { jobId: jobB["id"] }],
          ["build", { buildHash: "foreign-build" }],
          [
            "instance",
            { instance: { pid: 1000, birth: "foreign", version: "mock" } },
          ],
          ["rpc", { rpcId: "00000000-0000-0000-0000-000000000000" }],
        ] as const) {
          fs.writeFileSync(
            entry.file,
            JSON.stringify({ ...entry.value, ...change }),
          );
          await assert.rejects(
            f.a.call("reconcile", { jobId: jobA["id"] }),
            { code: "RECEIPT_MISMATCH" },
            name,
          );
          assert.equal(
            object((await f.a.call("result", { jobId: jobA["id"] }))["job"])[
              "state"
            ],
            "needs_reconciliation",
            name,
          );
          assert.equal((await restarted.call("counts"))["sends"], 0, name);
          assert.equal((await restarted.call("counts"))["calls"], 0, name);
        }
        fs.writeFileSync(entry.file, JSON.stringify(entry.value));
        const settled = await f.a.call("reconcile", { jobId: jobA["id"] });
        assert.equal(
          settled["state"],
          "failed",
          "matching postflight evidence permits safe settlement, not fabrication of the missing local result",
        );
        assert.equal(settled["code"], "RESULT_UNAVAILABLE");
        assert.equal((await restarted.call("status"))["blocked"], null);
        await restarted.event("physical", "B");
        assert.equal(
          (await restarted.call("counts"))["sends"],
          1,
          "only the newly accepted B request may execute; neither old mutation is replayed",
        );
        await restarted.call("release-physical", { tag: "B" });
        await restarted.event("publishing", "B");
        await restarted.call("release-publish", { tag: "B" });
        const resultB = await f.b.call("complete", { jobId: queuedB["id"] });
        assert.equal(
          object(resultB["job"])["requestId"],
          "request-B-after-restart",
        );
        assert.equal(object(resultB["job"])["state"], "succeeded");
        assert.equal((await restarted.call("counts"))["maximum"], 1);
        assert.equal((await restarted.call("counts"))["sends"], 1);
      }
    },
  );
}
