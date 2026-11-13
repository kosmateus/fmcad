import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import type * as P from "../src/queue-broker-ports";
import type { BackendTransitionApproval } from "../src/queue-backend-transition";

const runtimeRoot = process.env["FMCAD_TEST_RUNTIME"] || process.cwd();
const load = createRequire(path.join(runtimeRoot, "src/queue-broker.js"));
const lifecycle = load(
  "./queue-backend-transition",
) as typeof import("../src/queue-backend-transition");
const { serve } = load(
  "./queue-broker",
) as typeof import("../src/queue-broker");
const fixture = createRequire(
  path.join(process.cwd(), "tests/queue-backend-transition.test.js"),
)("./fixtures/closed-epoch-successor.cjs") as (
  root: string,
  repo: string,
  mode: string,
) => {
  dir: string;
  cfg: P.Config;
  clientId: string;
  token: string;
  state: P.State;
  epoch: P.Epoch;
};

function setup() {
  const root = fs.mkdtempSync(path.join(tmpdir(), "fmcad-backend-transition-"));
  const f = fixture(root, runtimeRoot, "normal-multidocument");
  fs.unlinkSync(path.join(f.dir, "broker.lock")); // This test's synthetic owner only.
  if (f.state.data.paused) f.state.pause(false, "synthetic-transition-test");
  const next = {
    ...f.cfg,
    backend: "mcp",
    url: "http://127.0.0.1:27182/mcp",
    headers: { "X-Synthetic-Endpoint": "mcp" },
    tool: "fusion_mcp_execute",
    protocolVersion: "2024-11-05",
  };
  const approval: BackendTransitionApproval = {
    requestId: "to-mcp",
    clientId: f.clientId,
    clientToken: f.token,
    previousConfig: f.cfg,
    nextConfig: next,
  };
  return { ...f, root, next, approval };
}

test("owner transition preserves predecessor identity/history; inverse transition keeps the chain", () => {
  const f = setup();
  try {
    const originals = [
      path.join(f.dir, "instance.json"),
      path.join(f.epoch.root, "instance.json"),
      path.join(f.dir, "queue-state.json"),
      path.join(f.dir, "isolated-admission-epoch.json"),
    ].map((file) => ({ file, bytes: fs.readFileSync(file) }));
    const prepared = lifecycle.prepareBackendTransition(
      f.dir,
      f.state,
      f.next,
      f.approval,
    );
    const instance = {
      ...prepared.identity.instance,
      activeCommand: "SelectCommand",
      documents: [],
    };
    prepared.commit(instance, prepared.identity.buildHash);
    const mcp = lifecycle.backendHead(f.dir)!;
    assert.equal(
      mcp.identity.configHash,
      load("./queue-instance").brokerConfigHash(f.next),
    );
    const mcpBytes = fs.readFileSync(mcp.identityFile);
    const inverse = lifecycle.prepareBackendTransition(f.dir, f.state, f.cfg, {
      ...f.approval,
      requestId: "back-to-addin",
      previousConfig: f.next,
      nextConfig: f.cfg,
    });
    inverse.commit(instance, prepared.identity.buildHash);
    assert.equal(
      lifecycle.backendHead(f.dir)!.identity.configHash,
      prepared.identity.configHash,
    );
    assert.deepEqual(fs.readFileSync(mcp.identityFile), mcpBytes);
    for (const original of originals)
      assert.deepEqual(fs.readFileSync(original.file), original.bytes);
    const head = path.join(f.dir, "physical-backend-head.json");
    const tampered = JSON.parse(fs.readFileSync(head, "utf8")) as {
      nextConfigHash: string;
    };
    tampered.nextConfigHash = "tampered";
    fs.writeFileSync(head, JSON.stringify(tampered));
    assert.throws(() => lifecycle.backendHead(f.dir), {
      code: "BACKEND_TRANSITION_CHANGED",
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("foreign/config/active/unknown refusals precede physical client construction and lock", async () => {
  const f = setup();
  let physicalClients = 0;
  const options: P.Options = {
    dir: f.dir,
    confirmOwnership: true,
    createBackend() {
      physicalClients++;
      throw new Error("physical backend must not be constructed");
    },
  };
  try {
    await assert.rejects(
      serve(f.next, {
        ...options,
        backendTransition: { ...f.approval, clientToken: "foreign" },
      }),
      { code: "NOT_OWNER" },
    );
    await assert.rejects(serve(f.next, options), { code: "CONFIG_CHANGED" });
    await assert.rejects(
      serve(f.next, {
        ...options,
        backendTransition: {
          ...f.approval,
          previousConfig: { ...f.cfg, timeoutMs: 1234 },
        },
      }),
      { code: "CONFIG_CHANGED" },
    );
    await assert.rejects(
      serve(f.next, {
        ...options,
        backendTransition: {
          ...f.approval,
          nextConfig: { ...f.next, tool: "tampered" },
        },
      }),
      { code: "CONFIG_CHANGED" },
    );
    const changedTimeout = { ...f.next, timeoutMs: 1234 };
    await assert.rejects(
      serve(changedTimeout, {
        ...options,
        backendTransition: {
          ...f.approval,
          nextConfig: changedTimeout,
        },
      }),
      { code: "CONFIG_CHANGED" },
    );
    for (const field of [
      "active",
      "blocked",
      "localUnknown",
      "controlBlocked",
      "lease",
    ] as const) {
      const old = f.state.data[field];
      Object.assign(f.state.data, { [field]: { synthetic: true } });
      assert.throws(
        () =>
          lifecycle.prepareBackendTransition(
            f.dir,
            f.state,
            f.next,
            f.approval,
          ),
        { code: "EPOCH_BUSY" },
      );
      Object.assign(f.state.data, { [field]: old });
    }
    f.state.data.jobs["synthetic-unknown"] = {
      id: "synthetic-unknown",
      requestId: "unknown",
      clientId: f.clientId,
      kind: "rpc",
      request: {
        kind: "rpc",
        requestId: "unknown",
        clientId: f.clientId,
        timeoutMs: 1000,
      },
      hash: "synthetic",
      order: 1,
      state: "unknown",
      submittedAt: 1,
      queueDeadline: null,
      timeoutMs: 1000,
      sequenceId: null,
      sequenceState: null,
    };
    assert.throws(
      () =>
        lifecycle.prepareBackendTransition(f.dir, f.state, f.next, f.approval),
      { code: "EPOCH_BUSY" },
    );
    delete f.state.data.jobs["synthetic-unknown"];
    assert.equal(physicalClients, 0);
    assert.equal(fs.existsSync(path.join(f.dir, "broker.lock")), false);
    assert.equal(
      fs.existsSync(path.join(f.dir, "physical-backend-head.json")),
      false,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("changed Fusion or predecessor bytes cannot commit and original request is never replayed", () => {
  const f = setup();
  try {
    const prepared = lifecycle.prepareBackendTransition(
      f.dir,
      f.state,
      f.next,
      f.approval,
    );
    assert.throws(
      () =>
        prepared.commit(
          {
            ...prepared.identity.instance,
            birth: "other",
            activeCommand: "SelectCommand",
            documents: [],
          },
          "build",
        ),
      { code: "INSTANCE_CHANGED" },
    );
    assert.throws(
      () =>
        prepared.commit(
          {
            ...prepared.identity.instance,
            activeCommand: "SelectCommand",
            documents: [{ isModified: true }],
          },
          "build",
        ),
      { code: "INSTANCE_CHANGED" },
    );
    fs.appendFileSync(path.join(f.epoch.root, "instance.json"), " ");
    assert.throws(() => prepared.assertEvidence(), {
      code: "BACKEND_TRANSITION_CHANGED",
    });
    assert.equal(
      fs.existsSync(path.join(f.dir, "physical-backend-head.json")),
      false,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("sole broker probes target once, reopens matching head without SDK, and returns to addin", async () => {
  const f = setup();
  let probes = 0;
  let handle: Awaited<ReturnType<typeof serve>> | undefined;
  const originalIdentity = fs.readFileSync(
    path.join(f.epoch.root, "instance.json"),
  );
  const observation = {
    ...f.epoch.currentInstance,
    activeCommand: "SelectCommand",
    documents: [],
  };
  const options: P.Options = {
    dir: f.dir,
    confirmOwnership: true,
    autoReconcile: false,
    nativePath: (file) => file,
    createBackend: () => ({
      server: { timeoutMs: 1000 },
      _parse: (raw: string) => JSON.parse(raw) as P.Reply,
      _openSession: () => {
        throw new Error("Unexpected session");
      },
      listTools: () => {
        throw new Error("Unexpected catalog");
      },
      executeUiGuardedScript: () => {
        throw new Error("Unexpected script");
      },
      _post: () => {
        throw new Error("Original job replay forbidden");
      },
      callTool: async () => {
        probes++;
        return {
          failed: false,
          text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(observation),
        };
      },
    }),
  };
  try {
    handle = await serve(f.next, { ...options, backendTransition: f.approval });
    assert.equal(probes, 1);
    assert.equal(handle.status().held, null);
    await handle.close();
    handle = undefined;
    handle = await serve(f.next, options);
    assert.equal(probes, 1);
    await handle.close();
    handle = undefined;
    handle = await serve(f.cfg, {
      ...options,
      backendTransition: {
        ...f.approval,
        requestId: "restore-addin",
        previousConfig: f.next,
        nextConfig: f.cfg,
      },
    });
    assert.equal(probes, 2);
    await handle.close();
    handle = undefined;
    assert.deepEqual(
      fs.readFileSync(path.join(f.epoch.root, "instance.json")),
      originalIdentity,
    );
  } finally {
    if (handle) await handle.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("uncertain target probe retains sole ownership and cannot replay on another startup", async () => {
  const f = setup();
  let probes = 0;
  const options: P.Options = {
    dir: f.dir,
    confirmOwnership: true,
    autoReconcile: false,
    backendTransition: f.approval,
    nativePath: (file) => file,
    createBackend: () => ({
      server: { timeoutMs: 1000 },
      _parse: (raw: string) => JSON.parse(raw) as P.Reply,
      _openSession: () => {
        throw new Error("Unexpected session");
      },
      listTools: () => {
        throw new Error("Unexpected catalog");
      },
      executeUiGuardedScript: () => {
        throw new Error("Unexpected script");
      },
      _post: () => {
        throw new Error("Original job replay forbidden");
      },
      callTool: () => {
        probes++;
        throw Object.assign(new Error("Probe transport outcome unknown"), {
          code: "TRANSPORT_UNKNOWN",
        });
      },
    }),
  };
  try {
    await assert.rejects(serve(f.next, options));
    assert.equal(probes, 1);
    const marker = fs.readFileSync(path.join(f.dir, "broker.lock"));
    await assert.rejects(serve(f.next, options));
    assert.equal(probes, 1);
    assert.deepEqual(fs.readFileSync(path.join(f.dir, "broker.lock")), marker);
    assert.equal(
      fs.existsSync(path.join(f.dir, "physical-backend-head.json")),
      false,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("CLI requires an explicit transition verb and a private bounded approval file", async () => {
  const f = setup();
  const { queueCommand } = load("./dist/entrypoints/queue-cli") as {
    queueCommand(
      argv: string[],
      deps: {
        loadConfig(): { cfg: P.Config };
        stdout: { write(text: string): void };
        stderr: { write(text: string): void };
      },
    ): Promise<number>;
  };
  const deps = {
    loadConfig: () => ({ cfg: f.next }),
    stdout: { write() {} },
    stderr: { write() {} },
  };
  try {
    for (const name of ["serve", "reclaim", "status"])
      await assert.rejects(
        queueCommand([name, "--backend-approval", "/unused"], deps),
        /requires transition-backend/,
      );
    await assert.rejects(
      queueCommand(["transition-backend", "--confirm-ownership", "true"], deps),
      /requires an exact private/,
    );
    const file = path.join(f.root, "public-approval.json");
    fs.writeFileSync(file, JSON.stringify(f.approval), { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    await assert.rejects(
      queueCommand(
        [
          "transition-backend",
          "--backend-approval",
          file,
          "--confirm-ownership",
          "true",
        ],
        deps,
      ),
      /bounded private regular file/,
    );
    assert.equal(fs.existsSync(path.join(f.dir, "broker.lock")), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("supported owner stop authorizes one paused transition without implicitly resuming", async () => {
  const f = setup();
  let handle: Awaited<ReturnType<typeof serve>> | undefined;
  let probes = 0;
  const { request } = load("./queue-connection") as {
    request(
      dir: string,
      message: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
  };
  const { openIsolatedEpoch } = load("./queue-isolated-epoch") as {
    openIsolatedEpoch(dir: string, options: { recover: false }): P.State;
  };
  const options: P.Options = {
    dir: f.dir,
    confirmOwnership: true,
    autoReconcile: false,
    nativePath: (file) => file,
    createBackend: () => ({
      server: { timeoutMs: 1000 },
      _parse: (raw: string) => JSON.parse(raw) as P.Reply,
      _openSession: () => {
        throw new Error("Unexpected session");
      },
      listTools: () => {
        throw new Error("Unexpected catalog");
      },
      executeUiGuardedScript: () => {
        throw new Error("Unexpected script");
      },
      _post: () => {
        throw new Error("Replay forbidden");
      },
      callTool: async () => {
        probes++;
        return {
          failed: false,
          text:
            "FMCAD_QUEUE_INSTANCE " +
            JSON.stringify({
              ...f.epoch.currentInstance,
              activeCommand: "SelectCommand",
              documents: [],
            }),
        };
      },
    }),
  };
  try {
    handle = await serve(f.cfg, options);
    const auth = { clientId: f.clientId, clientToken: f.token };
    const control = await request(f.dir, { action: "control-status", auth });
    const stopped = await request(f.dir, {
      action: "console-stop",
      auth,
      control: {
        requestId: "actual-owner-stop",
        instanceId: control["instanceId"],
        expectedGeneration: control["generation"],
      },
    });
    await handle.close();
    handle = undefined;
    const releaseFile = String(stopped["releaseFile"]);
    await new Promise<void>((resolve, reject) => {
      const watcher = fs.watch(f.dir, inspect);
      watcher.once("error", reject);
      function inspect() {
        if (fs.existsSync(releaseFile)) {
          watcher.close();
          resolve();
        }
      }
      inspect();
    });
    assert.equal(
      openIsolatedEpoch(f.dir, { recover: false }).data.paused,
      true,
    );
    await assert.rejects(
      serve(f.next, { ...options, backendTransition: f.approval }),
      { code: "EPOCH_BUSY" },
    );
    assert.equal(probes, 0);
    const release = fs.readFileSync(releaseFile);
    fs.writeFileSync(
      releaseFile,
      JSON.stringify({ terminal: true, outcome: "retained" }),
    );
    await assert.rejects(
      serve(f.next, {
        ...options,
        backendTransition: {
          ...f.approval,
          stopRequestId: "actual-owner-stop",
        },
      }),
      { code: "BACKEND_TRANSITION_UNPROVEN" },
    );
    fs.writeFileSync(releaseFile, release);
    handle = await serve(f.next, {
      ...options,
      backendTransition: { ...f.approval, stopRequestId: "actual-owner-stop" },
    });
    assert.equal(probes, 1);
    assert.equal(
      handle.status().paused,
      true,
      "Backend transition must preserve the owner stop pause",
    );
    await handle.close();
    handle = undefined;
    await assert.rejects(
      serve(f.cfg, {
        ...options,
        backendTransition: {
          ...f.approval,
          requestId: "cannot-reuse-stop",
          previousConfig: f.next,
          nextConfig: f.cfg,
          stopRequestId: "actual-owner-stop",
        },
      }),
      { code: "BACKEND_TRANSITION_UNPROVEN" },
    );
    assert.equal(probes, 1);
    handle = await serve(f.next, options);
    assert.equal(handle.status().paused, true);
    assert.equal(probes, 1);
  } finally {
    if (handle) await handle.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
