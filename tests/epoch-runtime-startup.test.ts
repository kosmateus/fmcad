import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import type { CurrentEpochFixture } from "./fixtures/epoch-fixture-types";
const repository = process.cwd();
const load = createRequire(
  path.join(repository, "tests", "epoch-runtime-startup.test.js"),
);

const { claimEpochRuntimeBroker } = load(
  "../src/queue-epoch-runtime-upgrade",
) as typeof import("../src/queue-epoch-runtime-upgrade");
const api = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;

function fixture(t: TestContext) {
  const base = fs.mkdtempSync("/tmp/opencode/epoch-upgrade-claim-");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return (
    load("./fixtures/current-epoch-upgrade.cjs") as (
      base: string,
      root: string,
    ) => CurrentEpochFixture
  )(base, repository);
}
test("actual broker startup uses the existing epoch identity and claims metadata-only under exact guarded journal", async (t) => {
  const f = fixture(t),
    original = fs.readFileSync(path.join(f.dir, "queue-state.json"));
  const epochState = fs.readFileSync(
    path.join(f.pointer.root, "queue-state.json"),
  );
  let physical = 0;
  const backend = {
    server: { timeoutMs: 1000 },
    _parse: JSON.parse,
    async _post() {
      physical++;
      assert.fail("Epoch upgrade startup must send NO SDK or initialization");
    },
    async callTool() {
      physical++;
      assert.fail("No startup probe");
    },
  };
  const broker = await (
    load("../src/queue-broker") as typeof import("../src/queue-broker")
  ).serve(f.cfg, {
    dir: f.dir,
    confirmOwnership: true,
    epochRuntimeUpgradeNonce: f.nonce,
    createBackend: () =>
      backend as unknown as import("../src/queue-broker-ports").Client,
    autoReconcile: false,
  });
  assert.equal(physical, 0);
  assert.deepEqual(
    fs.readFileSync(path.join(f.dir, "queue-state.json")),
    original,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(f.pointer.root, "queue-state.json")),
    epochState,
  );
  assert.equal(
    (broker.status() as unknown as { admissionEpoch: string }).admissionEpoch,
    f.pointer.epochId,
  );
  const summary = await (
    load(
      "../src/queue-connection",
    ) as typeof import("../src/entrypoints/queue-connection")
  ).request(f.dir, {
    action: "queue-summary",
    auth: { clientId: f.clientId, clientToken: f.token },
  });
  assert.equal(
    (summary as { sourceCommit: string }).sourceCommit,
    f.approval.sourceCommit,
  );
  await broker.close();
  assert.equal(physical, 0);
});
test(
  "ordinary broker cooperatively pauses/stops an epoch under startup-only recovery guard without SDK or old-history edits",
  {},
  async (t) => {
    const f = fixture(t),
      frozen = repository;
    const oldHash = (
      load(frozen + "/src/queue-instance") as ReturnType<
        typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
      >
    ).buildHash(frozen);
    const epochIdentity = path.join(f.pointer.root, "instance.json");
    api.durable(epochIdentity, {
      ...(JSON.parse(fs.readFileSync(epochIdentity, "utf8")) as Record<
        string,
        unknown
      >),
      buildHash: oldHash,
    });
    for (const name of ["recovery.lock", "atomic-migration.lock"])
      fs.unlinkSync(path.join(f.dir, name)); // Only synthetic fixture files.
    const rootBefore = fs.readFileSync(path.join(f.dir, "queue-state.json"));
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
    (async()=>{const assert=require('node:assert/strict');const b=await require(${JSON.stringify(frozen + "/src/queue-broker")}).serve(${JSON.stringify(f.cfg)},
      {dir:${JSON.stringify(f.dir)},confirmOwnership:true,autoReconcile:false,createBackend:()=>({server:{timeoutMs:1000},_parse:JSON.parse,
        _post(){assert.fail('No SDK on metadata-only epoch repair')},callTool(){assert.fail('No probe')}})});
      console.log('ready');})().catch(e=>{console.error(e);process.exitCode=1});
  `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const exited = once(child, "exit");
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await exited;
    });
    const first = await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => {
        throw new Error("Fixture broker exited before ready");
      }),
    ]);
    assert.match((first[0] as Buffer).toString(), /ready/);
    const call = (action: string, extra: Record<string, unknown> = {}) =>
      (
        load(
          "../src/queue-connection",
        ) as typeof import("../src/entrypoints/queue-connection")
      ).request(f.dir, {
        action,
        auth: { clientId: f.clientId, clientToken: f.token },
        ...extra,
      });
    const before = (await call("queue-summary")) as {
      control: { instanceId: string; generation: number };
    };
    await call("pause", {
      control: {
        requestId: "fixture-upgrade:pause",
        instanceId: before.control.instanceId,
        expectedGeneration: before.control.generation,
      },
    });
    const paused = (await call("queue-summary")) as {
      control: { instanceId: string; generation: number; gateClosed: boolean };
    };
    assert.equal(paused.control.gateClosed, true);
    api.durable(path.join(f.dir, "recovery.lock"), f.guard, true);
    await call("stop", {
      control: {
        requestId: "fixture-upgrade:stop",
        instanceId: paused.control.instanceId,
        expectedGeneration: paused.control.generation,
      },
    });
    const result = await exited;
    assert.equal(result[0], 0);
    assert.equal(fs.existsSync(path.join(f.dir, "broker.lock")), false);
    assert.deepEqual(
      fs.readFileSync(path.join(f.dir, "queue-state.json")),
      rootBefore,
    );
    assert.equal(
      fs.existsSync(path.join(f.dir, "recovery.lock")),
      true,
      "The startup guard remains owned by the repair",
    );
  },
);
for (const [name, mutate] of [
  [
    "wrong nonce",
    (f) => {
      f.nonce = "wrong";
    },
  ],
  [
    "wrong build",
    (f) => {
      f.approval.buildHash = "wrong";
    },
  ],
  [
    "foreign guard",
    (f) => {
      api.durable(path.join(f.dir, "recovery.lock"), {
        ...f.guard,
        clientId: "foreign",
      });
    },
  ],
  [
    "another broker exists",
    (f) => {
      api.durable(
        path.join(f.dir, "broker.lock"),
        { pid: process.pid, birth: api.processBirth(), nonce: "another" },
        true,
      );
    },
  ],
  [
    "revoked credential",
    (f) => {
      api.durable(path.join(f.dir, "clients.json"), {
        [f.clientId]: "revoked",
      });
    },
  ],
  [
    "changed epoch state",
    (f) => {
      const file = path.join(f.pointer.root, "queue-state.json");
      const d = JSON.parse(fs.readFileSync(file, "utf8")) as {
        paused: boolean;
        revision: number;
      };
      d.paused = false;
      api.durable(file, d);
    },
  ],
  [
    "changed historical root",
    (f) => {
      const file = path.join(f.dir, "queue-state.json");
      const d = JSON.parse(fs.readFileSync(file, "utf8")) as {
        paused: boolean;
        revision: number;
      };
      d.revision++;
      api.durable(file, d);
    },
  ],
  [
    "changed SDK proof",
    (f) => {
      api.durable(f.pointer.qualificationEvidence[0]!.path, { forged: true });
    },
  ],
  [
    "forged grant",
    (f) => {
      api.durable(
        path.join(f.pointer.root, "access-" + "a".repeat(64) + ".json"),
        { clientId: "foreign" },
        true,
      );
    },
  ],
] satisfies ReadonlyArray<readonly [string, (f: CurrentEpochFixture) => void]>)
  test("startup rejects " + name + " without claiming a broker", (t) => {
    const f = fixture(t);
    mutate(f);
    const marker = {
      pid: process.pid,
      birth: api.processBirth(),
      nonce: "fixture-new",
    };
    assert.throws(() =>
      claimEpochRuntimeBroker(f.dir, marker, f.nonce, f.approval.buildHash),
    );
    if (name !== "another broker exists")
      assert.equal(fs.existsSync(path.join(f.dir, "broker.lock")), false);
  });
