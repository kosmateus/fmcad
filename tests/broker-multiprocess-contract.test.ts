import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

type RecordValue = Record<string, unknown>;
interface ProcessPort {
  child: { pid: number };
  events: RecordValue[];
  event(name: string, tag?: string): Promise<RecordValue>;
  call(action: string, values?: RecordValue): Promise<RecordValue>;
}
interface Fixture {
  directory: string;
  dir: string;
  server: ProcessPort;
  a: ProcessPort;
  b: ProcessPort;
}
const load = createRequire(__filename);
const { fixture } = load(
  path.resolve(
    __dirname,
    "../../tests/fixtures/broker-refactor-process/fixture.cjs",
  ),
) as { fixture(t: unknown, mode?: string): Promise<Fixture> };

test(
  "real serve serializes two independent QueueClient producers while preparation overlaps",
  { timeout: 60000 },
  async (t) => {
    const { directory, server, a, b } = await fixture(t);
    assert.equal(
      new Set([process.pid, server.child.pid, a.child.pid, b.child.pid]).size,
      4,
    );
    const jobA = await a.call("submit");
    const prepA = await server.event("preparing", "A");
    const jobB = await b.call("submit");
    const prepB = await server.event("preparing", "B");
    assert.notEqual(prepA["pid"], prepB["pid"]);
    assert.equal(
      (await server.call("counts"))["sends"],
      0,
      "both preparation barriers reached before either producer requests a physical turn",
    );

    // B may finish its local preparation while A is still held; there is no
    // global producer/suite reservation hiding the actual broker concurrency.
    await server.call("release-prepare", { tag: "B" });
    await server.event("physical", "B");
    await server.call("release-prepare", { tag: "A" });
    const waitingA = await server.call("wait-ready", { jobId: jobA["id"] });
    assert.equal(waitingA["id"], jobA["id"]);
    assert.equal(waitingA["clientId"], "owner-A");
    assert.equal(waitingA["requestId"], "request-A");
    assert.equal(waitingA["state"], "queued");
    assert.equal(typeof waitingA["sdkReadyAt"], "number");
    const duplicateB = await b.call("submit");
    assert.equal(duplicateB["id"], jobB["id"]);
    await assert.rejects(a.call("result", { jobId: jobB["id"] }), {
      code: "NOT_OWNER",
    });
    assert.deepEqual(await server.call("counts"), {
      active: 1,
      maximum: 1,
      sends: 1,
      calls: 3,
    });
    await server.call("release-physical", { tag: "B" });
    await server.event("publishing", "B");
    await server.event("physical", "A");
    assert.notEqual(
      ((await b.call("result", { jobId: jobB["id"] }))["job"] as RecordValue)[
        "state"
      ],
      "succeeded",
      "A enters its physical turn while B is still held in local publication",
    );
    await server.call("release-physical", { tag: "A" });
    const resultA = await a.call("complete", { jobId: jobA["id"] });
    await server.call("release-publish", { tag: "B" });
    const resultB = await b.call("complete", { jobId: jobB["id"] });
    for (const [tag, job, result] of [
      ["A", jobA, resultA],
      ["B", jobB, resultB],
    ] as const) {
      assert.equal(
        result["job"] && (result["job"] as RecordValue)["id"],
        job["id"],
      );
      const identity = result["job"] as RecordValue;
      assert.equal(identity["clientId"], "owner-" + tag);
      assert.equal(identity["requestId"], "request-" + tag);
      assert.equal(identity["state"], "succeeded");
      assert.ok(String(result["stdout"]).trim(), JSON.stringify(result));
      assert.deepEqual(JSON.parse(String(result["stdout"]).trim()), {
        tag,
        document: "document-" + tag,
      });
      const provenance = result["provenance"] as {
        inputs: Array<{ originalPath: string }>;
      };
      assert.deepEqual(
        provenance.inputs.map((input) => input.originalPath),
        [path.join(directory, "project-" + tag, tag + ".py")],
      );
    }
    assert.equal((await a.call("submit"))["id"], jobA["id"]);
    assert.equal((await b.call("submit"))["id"], jobB["id"]);
    assert.deepEqual(await server.call("counts"), {
      active: 0,
      maximum: 1,
      sends: 2,
      calls: 7,
    });
  },
);

test(
  "a revoked grant cannot send a waiting preflight",
  { timeout: 30000 },
  async (t) => {
    const { dir, server, a } = await fixture(t, "unsent-preflight");
    const job = await a.call("submit");
    await server.event("preparing", "A");
    await server.call("release-prepare", { tag: "A" });
    await server.event("preflight-waiting");
    const counts = await server.call("counts");
    await server.call("kill-worker", { tag: "A" });
    await server.call("release-probe", { stage: "preflight" });
    assert.deepEqual(
      await server.call("counts"),
      counts,
      "revocation must prevent the actual probe send",
    );
    const result = await a.call("result", { jobId: job["id"] });
    assert.equal(
      (result["job"] as RecordValue)["state"],
      "needs_reconciliation",
    );
    const directory = path.join(dir, "jobs", String(job["id"]));
    assert.equal(
      fs.existsSync(path.join(directory, "preflight-start.json")),
      false,
    );
    assert.equal(fs.existsSync(path.join(directory, "preflight.json")), false);
    assert.equal(fs.existsSync(path.join(directory, "outcome.json")), false);
  },
);

test(
  "a revoked grant cannot publish from an already-sent postflight reply",
  { timeout: 30000 },
  async (t) => {
    const { dir, server, a } = await fixture(t, "late-postflight");
    const job = await a.call("submit");
    await server.event("preparing", "A");
    await server.call("release-prepare", { tag: "A" });
    await server.event("physical", "A");
    await server.call("release-physical", { tag: "A" });
    await server.event("postflight");
    await server.call("kill-worker", { tag: "A" });
    await server.call("release-probe", { stage: "postflight" });
    const result = await a.call("result", { jobId: job["id"] });
    assert.equal(
      (result["job"] as RecordValue)["state"],
      "needs_reconciliation",
    );
    const directory = path.join(dir, "jobs", String(job["id"]));
    const intent = JSON.parse(
      fs.readFileSync(path.join(directory, "postflight-start.json"), "utf8"),
    ) as RecordValue;
    const receipt = JSON.parse(
      fs.readFileSync(String(intent["receipt"]), "utf8"),
    ) as RecordValue;
    assert.equal(receipt["terminal"], true);
    assert.equal(
      fs.existsSync(path.join(directory, "outcome.json")),
      false,
      "a late reply must not claim sdkSettled",
    );
    assert.equal(fs.existsSync(path.join(directory, "postflight.json")), false);
    assert.equal(
      fs.existsSync(path.join(directory, "postflight-result.json")),
      false,
    );
  },
);

test(
  "job reconciliation cannot clear the broker's independent listener fault",
  { timeout: 30000 },
  async (t) => {
    const { dir, server, a, b } = await fixture(t, "host-fault");
    const job = await a.call("submit");
    await server.event("preparing", "A");
    await server.call("release-prepare", { tag: "A" });
    await server.event("physical", "A");
    await server.call("release-physical", { tag: "A" });
    await server.event("postflight");
    const lock = fs.readFileSync(path.join(dir, "broker.lock"));
    await server.call("ipc-fault");
    assert.equal((await server.call("status"))["held"], "IPC_SERVER_ERROR");
    await server.call("kill-worker", { tag: "A" });
    await server.call("release-probe", { stage: "postflight" });
    const resolved = await a.call("reconcile", { jobId: job["id"] });
    assert.equal(resolved["state"], "failed");
    const status = await server.call("status");
    assert.equal(status["blocked"], null);
    assert.equal(status["held"], "IPC_SERVER_ERROR");
    const next = await b.call("submit", { queueTimeoutMs: 250 });
    await server.event("preparing", "B");
    await server.call("release-prepare", { tag: "B" });
    const waited = await b.call("complete", { jobId: next["id"] });
    assert.equal((waited["job"] as RecordValue)["state"], "expired");
    assert.equal((await server.call("counts"))["sends"], 1);
    await assert.rejects(a.call("stop"), { code: "RECONCILIATION_REQUIRED" });
    assert.deepEqual(fs.readFileSync(path.join(dir, "broker.lock")), lock);
  },
);
