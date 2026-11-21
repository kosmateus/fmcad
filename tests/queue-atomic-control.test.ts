import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

import { object, field } from "./modeling-unit-test-support";
const sourceDirectory = path.join(process.cwd(), "tests");
const sourceFile = path.join(sourceDirectory, "queue-atomic-control.test.ts");
const loadModule = createRequire(sourceFile);

const { observeAtomic } = loadModule(
  "../src/queue-atomic-control",
) as typeof import("../src/queue-atomic-control");
const { queueCommand } = loadModule(
  "../src/queue-cli",
) as typeof import("../src/entrypoints/queue-cli");

test("owner CLI refuses legacy brokers and build drift without submitting a job", async () => {
  for (const [status, code] of [
    [{ control: { buildHash: "approved" } }, "ATOMIC_OBSERVATION_UNSUPPORTED"],
    [
      {
        features: { atomicWorkflowObserve: true },
        control: { buildHash: "old-build" },
      },
      "BUILD_CHANGED",
    ],
  ]) {
    const calls: unknown[] = [];
    await assert.rejects(
      observeAtomic(
        {
          async call(action) {
            calls.push(action);
            return status;
          },
        },
        { jobId: "holder", requestId: "stable", buildHash: "approved" },
      ),
      { code },
    );
    assert.deepEqual(calls, ["queue-summary"]);
  }
});

test("owner CLI forwards the complete fence once without an identity override or raw argv", async () => {
  const calls: unknown[] = [];
  const control = {
    instanceId: "owner-instance",
    buildHash: "approved",
    generation: 24,
    contextEpoch: 12,
  };
  const job = { id: "observer" };
  const value = await observeAtomic(
    {
      async call(action, data) {
        calls.push({ action, data });
        return action === "queue-summary"
          ? { control, features: { atomicWorkflowObserve: true } }
          : job;
      },
    },
    { jobId: "holder", requestId: "stable", buildHash: "approved" },
  );
  assert.equal(value, job);
  assert.deepEqual(calls[1], {
    action: "observe-atomic",
    data: { jobId: "holder", requestId: "stable", control },
  });
  assert.equal(calls.length, 2);
});

test("lost owner-control acknowledgement is never retried automatically", async () => {
  let sends = 0;
  await assert.rejects(
    observeAtomic(
      {
        async call(action) {
          if (action === "queue-summary")
            return {
              features: { atomicWorkflowObserve: true },
              control: {
                buildHash: "approved",
                instanceId: "owner",
                generation: 24,
                contextEpoch: 12,
              },
            };
          sends++;
          throw Object.assign(new Error("lost ACK"), {
            code: "QUEUE_IPC_TIMEOUT",
          });
        },
      },
      { jobId: "holder", requestId: "stable", buildHash: "approved" },
    ),
    { code: "QUEUE_IPC_TIMEOUT" },
  );
  assert.equal(sends, 1);
});

test("owner CLI rejects missing stable identity and client/payload overrides before configuration", async () => {
  for (const argv of [
    [],
    ["--job", "holder"],
    ["--job", "holder", "--request-id", "stable", "--client", "foreign"],
    [
      "--job",
      "holder",
      "--request-id",
      "stable",
      "--accept-outcome",
      "aborted",
    ],
  ]) {
    await assert.rejects(
      invalidQueueCommand(["observe-atomic", ...argv], {
        loadConfig() {
          assert.fail(
            "invalid input must not read configuration or credentials",
          );
        },
      }),
      /observe-atomic requires/,
    );
  }
});

test("migration CLI requires exact explicit consent and rejects client/payload overrides before configuration", async () => {
  for (const argv of [
    [],
    [
      "--job",
      "holder",
      "--request-id",
      "migration",
      "--migration-approval",
      "/approved.json",
    ],
    [
      "--job",
      "holder",
      "--request-id",
      "migration",
      "--migration-approval",
      "/approved.json",
      "--preflight",
      "true",
      "--client",
      "foreign",
    ],
    [
      "--job",
      "holder",
      "--request-id",
      "migration",
      "--migration-approval",
      "/approved.json",
      "--preflight",
      "false",
    ],
  ]) {
    await assert.rejects(
      invalidQueueCommand(["migrate-atomic", ...argv], {
        loadConfig() {
          assert.fail(
            "invalid migration input must not read credentials/configuration",
          );
        },
      }),
      /migrate-atomic requires/,
    );
  }
  await assert.rejects(
    invalidQueueCommand(["pause", "--preflight", "true"], {
      loadConfig() {
        assert.fail(
          "a migration-only flag must not silently execute an ordinary pause",
        );
      },
    }),
    /available only for queue migrate-atomic/,
  );
});

test("owner-only CLI credential loading never creates a new identity when credentials are missing", (t) => {
  const fs = loadModule("node:fs") as typeof import("node:fs");
  const { spawnSync } = loadModule(
    "node:child_process",
  ) as typeof import("node:child_process");
  const dir = fs.mkdtempSync("/tmp/opencode/migration-existing-credentials-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = (loadModule("node:path") as typeof import("node:path")).resolve(
    sourceDirectory,
    "..",
  );
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const assert=require('node:assert/strict');
    const {QueueClient}=require(${JSON.stringify(root + "/src/queue-client")});
    assert.throws(()=>new QueueClient('missing-owner',{existingCredentialsOnly:true}),{code:'ENOENT'});
  `,
    ],
    { env: { ...process.env, XDG_STATE_HOME: dir }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    fs.readdirSync(dir),
    [],
    "owner-only admission must not mint a credential or client directory",
  );
});

test("typed observer control preserves retained owner, exact fence and derived request behavior", () => {
  const old = (
    loadModule(
      "./fixtures/historical-module.cjs",
    ) as typeof import("./fixtures/historical-module.cjs")
  )("330849f22302bcf0ee955cd1945ddb2040eff8c7", "src/queue-atomic-control.js");
  const current = loadModule(
    "../src/queue-atomic-control",
  ) as typeof import("../src/queue-atomic-control");
  const scope = {
    jobId: "holder",
    requestId: "original",
    projectDirectory: "/owned/project",
    reportPath: "/owned/report",
    commandId: "fmcad_atomic_" + "a".repeat(32),
    sessionNonce: "b".repeat(32),
    docId: "owned-doc",
  };
  const target = {
    id: "holder",
    requestId: "original",
    clientId: "owner",
    kind: "command",
    state: "needs_reconciliation",
    physicalTurns: 1,
    dispatch: { rpcCount: 1 },
    request: {
      backend: "addin",
      buildHash: "original-build",
      cwd: scope.projectDirectory,
      payload: {
        version: 1,
        kind: "cad",
        operation: "batch.run",
        doc: "Owned model",
        docId: scope.docId,
        data: {
          atomic: true,
          runId: "owned-run",
          reportPath: scope.reportPath,
        },
      },
    },
  };
  const control = {
    instanceId: "broker-owner",
    buildHash: "observer-build",
    generation: 3,
    contextEpoch: 4,
  };
  const message = { jobId: target.id, requestId: "observe-once", control };
  type MutableMessage = typeof message & {
    payload?: unknown;
    control: typeof control & { extra?: boolean };
  };
  const invoke = (
    api: unknown,
    m: MutableMessage = message,
    t = target,
  ): unknown => {
    const method = object(api)["observationRequest"];
    assert.equal(typeof method, "function");
    if (typeof method !== "function")
      throw new TypeError("Missing observationRequest");
    return Reflect.apply(method, api, [m, "owner", t, control, scope]);
  };
  assert.deepEqual(invoke(current), invoke(old));
  const mutations: ((m: MutableMessage, t: typeof target) => void)[] = [
    (m) => {
      m.payload = {};
    },
    (m) => {
      m.control.generation++;
    },
    (m) => {
      m.control.extra = true;
    },
    (m) => {
      m.control.buildHash = "foreign";
    },
    (_m, t) => {
      t.clientId = "foreign";
    },
    (_m, t) => {
      t.state = "succeeded";
    },
    (_m, t) => {
      t.request.payload.docId = "foreign";
    },
  ];
  for (const mutate of mutations) {
    const results: { code: unknown; message: unknown }[] = [];
    for (const api of [old, current]) {
      const m = structuredClone(message),
        t = structuredClone(target);
      mutate(m, t);
      assert.throws(
        () => invoke(api, m, t),
        (error) => {
          results.push({
            code: field(error, "code"),
            message: field(error, "message"),
          });
          return true;
        },
      );
    }
    assert.deepEqual(results[1], results[0]);
  }
});

async function invalidQueueCommand(
  argv: string[],
  ports: { loadConfig(): never },
): Promise<void> {
  // Preserve the incomplete original port to prove validation precedes any IO.
  await Reflect.apply(queueCommand, undefined, [argv, ports]);
}
