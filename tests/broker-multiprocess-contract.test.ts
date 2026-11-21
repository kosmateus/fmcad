import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

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

test(
  "a refused stop during UNKNOWN does not poison the broker after reconciliation",
  { timeout: 30000 },
  async (t) => {
    const { dir, server, a } = await fixture(t, "late-postflight");
    const job = await a.call("submit");
    await server.event("preparing", "A");
    await server.call("release-prepare", { tag: "A" });
    await server.event("physical", "A");
    await server.call("release-physical", { tag: "A" });
    await server.event("postflight");
    const lock = path.join(dir, "broker.lock");
    const originalOwner = fs.readFileSync(lock);
    const first = await a.call("stop");
    assert.equal(first["stopping"], true);
    assert.equal(first["draining"], true);
    await server.call("kill-worker", { tag: "A" });
    await server.call("release-probe", { stage: "postflight" });
    assert.deepEqual(fs.readFileSync(lock), originalOwner);
    const held = await server.call("status");
    assert.equal(held["stopping"], false);
    assert.equal(
      (held["jobs"] as Record<string, RecordValue>)[String(job["id"])]?.[
        "state"
      ],
      "needs_reconciliation",
    );
    const resolved = await a.call("reconcile", { jobId: job["id"] });
    assert.equal(resolved["state"], "failed");
    const status = await server.call("status");
    assert.equal(status["blocked"], null);
    assert.equal(status["held"], null);
    const retried = await a.call("stop");
    assert.equal(retried["stopping"], true);
    assert.equal(retried["draining"], false);
    assert.equal(await server.call("wait-unlocked"), true);
    assert.equal(fs.existsSync(lock), false);
  },
);

test(
  "public stop retains UNKNOWN recovery and flushes an accepted reply before unlocking",
  { timeout: 30000 },
  async (t) => {
    const { dir, server, a, b } = await fixture(t, "late-retirement");
    const job = await b.call("submit");
    await server.event("preparing", "B");
    await server.call("release-prepare", { tag: "B" });
    await server.event("physical", "B");
    await server.call("release-physical", { tag: "B" });
    await server.event("publishing", "B");
    const lock = path.join(dir, "broker.lock");
    const owner = fs.readFileSync(lock);
    assert.deepEqual(await a.call("stop"), { stopping: true, draining: false });
    await server.event("worker-retirement");
    await server.call("release-publish", { tag: "B" });
    await server.event("worker-retired");

    const held = await b.call("status");
    assert.equal(held["stopping"], true);
    assert.equal(
      (held["jobs"] as Record<string, RecordValue>)[String(job["id"])]?.[
        "state"
      ],
      "needs_reconciliation",
    );
    assert.deepEqual(fs.readFileSync(lock), owner);
    await assert.rejects(a.call("stop"), { code: "RECONCILIATION_REQUIRED" });

    const submitId = "new-request-while-stopping";
    const resumeId = "resume-request-while-stopping";
    await assert.rejects(a.call("submit", { requestId: submitId }), {
      code: "BROKER_STOPPING",
    });
    assert.equal(
      (await a.call("lookup", { requestId: submitId }))["job"],
      null,
    );
    await assert.rejects(a.call("resume", { requestId: resumeId }), {
      code: "BROKER_STOPPING",
    });
    const intent = `lifecycle-control-${createHash("sha256").update(resumeId).digest("hex")}.json`;
    assert.equal(fs.existsSync(path.join(dir, intent)), false);

    const resolved = await b.call("reconcile", { jobId: job["id"] });
    assert.equal(resolved["id"], job["id"]);
    assert.equal((await b.call("status"))["held"], null);
    assert.equal((await server.call("counts"))["sends"], 1);
    await assert.rejects(a.call("submit", { requestId: submitId }), {
      code: "BROKER_STOPPING",
    });

    await server.call("hold-status-reply");
    const reply = b.call("status");
    await server.event("status-reply-waiting");
    assert.deepEqual(await a.call("stop"), { stopping: true, draining: false });
    assert.deepEqual(fs.readFileSync(lock), owner);
    await server.call("release-probe", { stage: "status-reply" });
    const delivered = await reply;
    assert.equal(delivered["held"], null);
    assert.equal(delivered["stopping"], true);
    assert.equal(await server.call("wait-unlocked"), true);
    assert.equal(fs.existsSync(lock), false);
    assert.equal(await server.call("retirements"), 1);
  },
);

for (const stopFirst of [false, true]) {
  test(
    `public stop does not strand a turn needing an explicit resume (${stopFirst ? "stop before pause" : "pause before stop"})`,
    { timeout: 30000 },
    async (t) => {
      const { dir, server, a, b } = await fixture(t, "unsent-preflight");
      const job = await a.call("submit");
      await server.event("preparing", "A");
      await server.call("release-prepare", { tag: "A" });
      await server.event("preflight-waiting");
      const lock = path.join(dir, "broker.lock");
      const owner = fs.readFileSync(lock);
      if (stopFirst)
        assert.deepEqual(await a.call("stop"), {
          stopping: true,
          draining: true,
        });
      await b.call("pause", { requestId: "explicit-pause" });
      await server.call("release-probe", { stage: "preflight" });
      if (!stopFirst)
        await assert.rejects(a.call("stop"), { code: "BROKER_BUSY" });
      assert.equal((await a.call("status"))["stopping"], false);
      assert.equal((await a.call("control-status"))["phase"], "PAUSED");
      assert.equal((await server.call("counts"))["sends"], 0);
      assert.deepEqual(fs.readFileSync(lock), owner);
      await assert.rejects(a.call("stop"), { code: "BROKER_BUSY" });

      assert.equal(
        (await b.call("resume", { requestId: "explicit-resume" }))["phase"],
        "RUNNING",
      );
      const result = await a.call("complete", { jobId: job["id"] });
      const settled = result["job"] as RecordValue;
      assert.equal(settled["id"], job["id"]);
      assert.equal(settled["state"], "failed");
      assert.equal(settled["code"], "DOCUMENT_CHANGED");
      assert.equal(settled["mayHaveMutated"], false);
      assert.equal((await server.call("counts"))["sends"], 0);
      assert.deepEqual(await a.call("stop"), {
        stopping: true,
        draining: false,
      });
      assert.equal(await server.call("wait-unlocked"), true);
    },
  );
}

test(
  "public stopping broker reads only the original bound resume receipt without replay",
  { timeout: 30000 },
  async (t) => {
    const { dir, server, a, b } = await fixture(t);
    await a.call("pause", { requestId: "pause-for-original-resume" });
    const status = await a.call("control-status");
    const requestId = "original-resume";
    const control = {
      instanceId: status["instanceId"],
      expectedGeneration: status["generation"],
      requestId,
    };
    const beforeResume = await server.call("counts");
    const original = await a.call("resume", { control });
    assert.equal(original["phase"], "RUNNING");
    assert.ok(
      Number((await server.call("counts"))["calls"]) >
        Number(beforeResume["calls"]),
    );
    assert.deepEqual(await a.call("resume", { control }), original);

    const job = await a.call("submit");
    await server.event("preparing", "A");
    await server.call("release-prepare", { tag: "A" });
    await server.event("physical", "A");
    const receipt = path.join(
      dir,
      `lifecycle-control-${createHash("sha256").update(requestId).digest("hex")}.json`,
    );
    const persisted = fs.readFileSync(receipt);
    const inFlight = await server.call("counts");
    assert.deepEqual(await a.call("stop"), { stopping: true, draining: true });
    assert.deepEqual(await a.call("resume", { control }), original);
    await assert.rejects(b.call("resume", { control }), {
      code: "REQUEST_CONFLICT",
    });
    await assert.rejects(
      a.call("resume", { control, resetOwnerNonce: "different-owner-binding" }),
      {
        code: "REQUEST_CONFLICT",
      },
    );
    assert.deepEqual(fs.readFileSync(receipt), persisted);
    assert.deepEqual(await server.call("counts"), inFlight);

    await server.call("release-physical", { tag: "A" });
    assert.equal(await server.call("wait-unlocked"), true);
    assert.ok(job["id"]);
  },
);
