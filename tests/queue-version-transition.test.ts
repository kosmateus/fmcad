interface FixtureOptions {
  currentDocuments?: Array<{
    id: string;
    fileId?: null;
    isSaved: boolean;
    isModified: boolean;
  }>;
  oldPid?: number;
  pendingJob?: boolean;
  paused?: boolean;
}
import { createRequire } from "node:module";
const load = createRequire(
  path.join(process.cwd(), "tests", "queue-version-transition.test.js"),
);

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Explicit fake physical backends require only synthetic WSL path spelling.
test.beforeEach((t) =>
  (t as test.TestContext).after(
    (load("./fixtures/fake-wsl-platform.cjs") as () => () => void)(),
  ),
);
const { QueueState } = load(
  "../src/queue-state",
) as typeof import("../src/queue-state");
const brokerModule = load(
  "../src/queue-broker",
) as typeof import("../src/queue-broker");
const { brokerConfigHash, serve } = brokerModule;
const { queueCommand } = load(
  "../src/queue-cli",
) as typeof import("../src/entrypoints/queue-cli");
const qi = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;

const config = {
  backend: "addin",
  url: "http://127.0.0.1:8765/mcp",
  headers: {},
  timeoutMs: 1000,
  tool: "execute_python",
  transport: "node",
  protocolVersion: "2025-06-18",
  routing: "queue",
  queue: { autoStart: true },
  controlCenter: { port: 4748 },
} as const;

function fixture(
  t: test.TestContext,
  {
    currentDocuments,
    oldPid,
    pendingJob = false,
    paused = false,
  }: FixtureOptions = {},
) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-version-transition-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const state = new QueueState(dir);
  let pendingJobId: string | undefined;
  if (pendingJob) {
    pendingJobId = state.submit({
      kind: "command",
      requestId: "pending-before-version-transition",
      clientId: "owner",
      timeoutMs: 1000,
      argv: ["doc", "list"],
      cwd: dir,
    })["id"] as string;
  }
  if (paused) state.pause(true, "test-pause");

  const previous = {
    pid: oldPid ?? 2147483647,
    birth: oldPid === process.pid ? qi.processBirth() : "old-boot:1",
    version: "2705.1.25",
    activeCommand: "SelectCommand",
    documents: [{ id: "old-document", isSaved: false, isModified: true }],
  };
  const current = {
    pid: 50352,
    birth: "new-windows-process-birth",
    version: "2706.1.14",
    activeCommand: "SelectCommand",
    documents: currentDocuments ?? [
      {
        id: "current-document",
        fileId: null,
        isSaved: false,
        isModified: false,
      },
    ],
  };
  const oldIdentity = {
    configHash: brokerConfigHash(config),
    buildHash: "old-runtime-build",
    instance: previous,
  };
  qi.durable(path.join(dir, "instance.json"), oldIdentity);

  let probes = 0;
  const client = {
    server: { timeoutMs: 1000 },
    _post() {
      throw Error("No product RPC expected");
    },
    _parse: JSON.parse,
    async callTool() {
      probes++;
      return {
        failed: false,
        text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(current),
      };
    },
  };
  return {
    dir,
    previous,
    current,
    oldIdentity,
    pendingJobId,
    probes: () => probes,
    client,
  };
}

test("explicit quiescent Fusion version transition records both identities before readiness", async (t) => {
  const f = fixture(t);
  const broker = await serve(config, {
    dir: f.dir,
    confirmOwnership: true,
    confirmVersionTransition: true,
    createBackend: () =>
      f.client as unknown as import("../src/queue-broker-ports").Client,
  });

  try {
    assert.equal(f.probes(), 1);
    const identity = qi.readJson(path.join(f.dir, "instance.json")) as {
      instance: { version: string };
      configHash: string;
    };
    assert.equal(identity.instance.version, "2706.1.14");
    assert.equal(identity.configHash, f.oldIdentity.configHash);
    const files = fs
      .readdirSync(f.dir)
      .filter((name) => name.startsWith("instance-transition-"));
    assert.equal(files.length, 1);
    const transition = qi.readJson(path.join(f.dir, files[0]!)) as {
      source: string;
      previous: unknown;
      current: unknown;
    };
    assert.equal(transition.source, "explicit-quiescent-version-transition");
    assert.deepEqual(transition.previous, f.previous);
    assert.deepEqual(transition.current, f.current);
    assert.equal(broker.status().held, null);
  } finally {
    await broker.close();
  }
});

test("version transition stays fenced without explicit confirmation or clean, quiescent state", async (t) => {
  const cases = [
    { name: "explicit confirmation", options: {} },
    {
      name: "modified current document",
      options: { confirmVersionTransition: true },
      fixture: {
        currentDocuments: [
          { id: "current-document", isSaved: false, isModified: true },
        ],
      },
    },
    {
      name: "live previous Fusion process",
      options: { confirmVersionTransition: true },
      fixture: { oldPid: process.pid },
    },
    {
      name: "nonterminal queued job",
      options: { confirmVersionTransition: true },
      fixture: { pendingJob: true },
    },
    {
      name: "manual queue pause",
      options: { confirmVersionTransition: true },
      fixture: { paused: true },
    },
  ];

  for (const scenario of cases) {
    const f = fixture(t, scenario.fixture);
    await assert.rejects(
      serve(config, {
        dir: f.dir,
        confirmOwnership: true,
        ...scenario.options,
        createBackend: () =>
          f.client as unknown as import("../src/queue-broker-ports").Client,
      }),
      { code: "INSTANCE_CHANGED" },
      scenario.name,
    );
    assert.equal(f.probes(), 1, scenario.name);
    assert.deepEqual(
      qi.readJson(path.join(f.dir, "instance.json")),
      f.oldIdentity,
      scenario.name,
    );
    const state = new QueueState(f.dir);
    assert.equal(
      f.pendingJobId === undefined
        ? undefined
        : state.data.jobs[f.pendingJobId]?.state,
      scenario.fixture?.pendingJob ? "queued" : undefined,
    );
  }
});

test("queue serve passes the version-transition flag only as explicit confirmation", async (t) => {
  const modulePort = brokerModule as unknown as {
    serve(
      cfg: unknown,
      options: Record<string, unknown>,
    ): Promise<{ socket: string; buildHash: string }>;
  };
  const originalServe = modulePort.serve;
  const beforeSignals = new Map(
    (["SIGINT", "SIGTERM"] as const).map((signal) => [
      signal,
      new Set(process.listeners(signal)),
    ]),
  );
  let received: { cfg: unknown; options: Record<string, unknown> } | undefined;
  modulePort.serve = async (cfg, options) => {
    received = { cfg, options };
    return { socket: "/tmp/fake-broker.sock", buildHash: "test-build" };
  };
  t.after(() => {
    modulePort.serve = originalServe;
    for (const [signal, before] of beforeSignals) {
      for (const listener of process.listeners(signal))
        if (!before.has(listener)) process.removeListener(signal, listener);
    }
  });

  await queueCommand(
    [
      "serve",
      "--confirm-ownership",
      "true",
      "--confirm-version-transition",
      "true",
    ],
    {
      loadConfig: () => ({ cfg: config }),
      stdout: { write() {} },
      stderr: { write() {} },
    },
  );

  assert.ok(received);
  assert.equal(received.options["confirmOwnership"], true);
  assert.equal(received.options["confirmVersionTransition"], true);
});
