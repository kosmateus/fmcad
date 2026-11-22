import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import type * as P from "../src/queue-broker-ports";
import type { BackendTransitionApproval } from "../src/queue-backend-transition";
import type { TestContext } from "node:test";
import type {
  DeadEpochFixture,
  FixturePointer,
} from "./fixtures/epoch-fixture-types";

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
  currentInstance?: P.Instance,
  sourceConfig?: P.Config,
) => {
  dir: string;
  cfg: P.Config;
  clientId: string;
  token: string;
  state: P.State;
  epoch: P.Epoch;
};
const { runBoundInstanceProbe } = createRequire(
  path.join(process.cwd(), "tests/queue-backend-transition.test.js"),
)("./fixtures/bound-instance-probe.cjs") as {
  runBoundInstanceProbe(
    script: string,
    identity: P.Instance,
  ): { text: string; receipt: Record<string, unknown> };
};

function setup(
  currentInstance?: P.Instance,
  sourceBackend: "addin" | "mcp" = "mcp",
  sourceUrl?: string,
  forPublicCli = false,
) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "fmcad-backend-transition-"));
  if (forPublicCli) fs.mkdirSync(path.join(root, "fmcad"));
  // MCP here is archived predecessor metadata only; new physical configs use ADDIN.
  const sourceConfig: P.Config =
    sourceBackend === "mcp"
      ? {
          backend: "mcp",
          url: "http://127.0.0.1:1/never-called",
          headers: {},
          tool: "fusion_mcp_execute",
          transport: "node",
          protocolVersion: "2025-06-18",
          timeoutMs: 180000,
          routing: "queue",
          queue: {},
        }
      : {
          backend: "addin",
          url: sourceUrl || "http://127.0.0.1:8765/mcp",
          headers: {},
          tool: "execute_python",
          transport: "node",
          protocolVersion: "2025-06-18",
          timeoutMs: 180000,
          routing: "queue",
          queue: {},
        };
  const f = fixture(
    forPublicCli ? path.join(root, "fmcad") : root,
    runtimeRoot,
    "normal-multidocument",
    currentInstance,
    sourceConfig,
  );
  fs.unlinkSync(path.join(f.dir, "broker.lock")); // This test's synthetic owner only.
  if (f.state.data.paused) f.state.pause(false, "synthetic-transition-test");
  const next =
    sourceBackend === "mcp"
      ? {
          ...f.cfg,
          backend: "addin",
          url: "http://127.0.0.1:8765/mcp",
          headers: {},
          tool: "execute_python",
          protocolVersion: "2025-06-18",
        }
      : {
          ...f.cfg,
          url: "http://127.0.0.1:8765/transition",
        };
  const approval: BackendTransitionApproval = {
    requestId:
      sourceBackend === "mcp"
        ? "historical-mcp-to-addin"
        : "addin-config-change",
    clientId: f.clientId,
    clientToken: f.token,
    previousConfig: f.cfg,
    nextConfig: next,
  };
  return { ...f, root, next, approval };
}

test(
  "public owner stop upgrades a settled ADDIN backend head without changing SDK or history",
  { timeout: 30000 },
  async (t) => {
    const f = setup(undefined, "mcp", undefined, true);
    const qi = load("./queue-instance") as {
      hash(value: string): string;
      buildHash(): string;
    };
    const home = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = f.root;
    t.after(() => {
      if (home === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = home;
    });
    fs.mkdirSync(path.join(f.dir, "client-credentials"), { recursive: true });
    fs.writeFileSync(
      path.join(f.dir, "client-credentials", `${qi.hash(f.clientId)}.json`),
      JSON.stringify({ clientId: f.clientId, clientToken: f.token }),
      { mode: 0o600 },
    );
    const retained = [
      path.join(f.dir, "instance.json"),
      path.join(f.epoch.root, "instance.json"),
      path.join(f.dir, "isolated-admission-epoch.json"),
      path.join(f.dir, "queue-state.json"),
    ].map((file) => ({ file, bytes: fs.readFileSync(file) }));
    const observation = {
      ...f.epoch.currentInstance,
      activeCommand: "SelectCommand",
      documents: [],
    };
    let owner = spawn(
      process.execPath,
      [
        path.join(process.cwd(), "tests/fixtures/backend-transition-owner.cjs"),
        runtimeRoot,
        process.cwd(),
        f.dir,
        JSON.stringify(f.next),
        JSON.stringify(observation),
        JSON.stringify(f.approval),
        "a".repeat(64),
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let handle: Awaited<ReturnType<typeof serve>> | undefined;
    t.after(async () => {
      if (owner.exitCode === null && owner.signalCode === null) {
        const exited = once(owner, "exit");
        owner.kill("SIGKILL");
        await exited;
      }
      if (handle) await handle.close();
      fs.rmSync(f.root, { recursive: true, force: true });
    });
    await new Promise<void>((resolve, reject) => {
      owner.on("message", (raw: unknown) => {
        const m = raw as { kind: string; message?: string };
        if (m.kind === "ready") resolve();
        if (m.kind === "error") reject(new Error(m.message));
      });
      owner.once("exit", () => reject(new Error("Owner exited before ready")));
    });
    const originalHead = lifecycle.backendHead(f.dir)!;
    const originalHeadBytes = fs.readFileSync(
      path.join(f.dir, "physical-backend-head.json"),
    );
    // Exercise the real SDK0 reopen, not the fixture's explicit extra probe.
    const initialExit = once(owner, "exit");
    owner.send({ action: "exit" });
    await initialExit;
    owner = spawn(
      process.execPath,
      [
        "-e",
        `const { createRequire } = require('node:module');
         const path = require('node:path');
         const load = createRequire(path.join(process.argv[1], 'src/queue-broker.js'));
         load('./queue-instance').buildHash = () => 'a'.repeat(64);
         let handle;
         process.on('message', async () => {
           await handle.close(); process.disconnect();
         });
         load('./queue-broker').serve(JSON.parse(process.argv[3]), {
           dir: process.argv[2], confirmOwnership: true, autoReconcile: false,
           createBackend() {
             const forbidden = () => { throw new Error('SDK0 reopen must not send SDK work'); };
             return {server:{timeoutMs:1000}, _post:forbidden, _parse:JSON.parse,
               _openSession:forbidden, listTools:forbidden,
               executeUiGuardedScript:forbidden, callTool:forbidden};
           }
         }).then(value => { handle = value; process.send({kind:'ready'}); })
           .catch(error => { process.send({kind:'error', message:error.message}); process.disconnect(); });`,
        runtimeRoot,
        f.dir,
        JSON.stringify(f.next),
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    await new Promise<void>((resolve, reject) => {
      owner.on("message", (raw: unknown) => {
        const message = raw as { kind: string; message?: string };
        if (message.kind === "ready") resolve();
        else reject(new Error(message.message));
      });
      owner.once("exit", () =>
        reject(new Error("SDK0 owner exited before ready")),
      );
    });
    const reopenedOwner = JSON.parse(
      fs.readFileSync(path.join(f.dir, "broker.lock"), "utf8"),
    ) as { nonce: string };
    const reopenedReceipt = path.join(
      f.dir,
      `broker-startup-${reopenedOwner.nonce}.receipt.json`,
    );
    assert.equal(fs.existsSync(reopenedReceipt), false);
    const { queueCommand } = load("./dist/entrypoints/queue-cli") as {
      queueCommand(argv: string[], deps: object): Promise<number>;
    };
    let stdout = "";
    const deps = {
      loadConfig: () => ({ cfg: f.next }),
      stdout: {
        write(text: string) {
          stdout += text;
        },
      },
      stderr: { write() {} },
    };
    const stopRequestId = "addin-runtime-owner-stop";
    assert.equal(
      await queueCommand(
        ["stop", "--client", f.clientId, "--request-id", stopRequestId],
        deps,
      ),
      0,
    );
    const releaseFile = String(JSON.parse(stdout)["releaseFile"]);
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(releaseFile) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(releaseFile));
    const exited = once(owner, "exit");
    owner.send({ action: "exit" });
    await exited;
    const approval = {
      ...f.approval,
      requestId: "addin-runtime-upgrade",
      previousConfig: f.next,
      nextConfig: f.next,
      stopRequestId,
      nextBuildHash: qi.buildHash(),
    };
    const approvalFile = path.join(f.root, "runtime-approval.json");
    fs.writeFileSync(approvalFile, JSON.stringify(approval), { mode: 0o600 });
    let probes = 0;
    const broker = load("./queue-broker") as { serve: typeof serve };
    const originalServe = broker.serve;
    t.after(() => {
      broker.serve = originalServe;
    });
    broker.serve = async (config, options) => {
      handle = await originalServe(config, {
        ...options,
        dir: f.dir,
        nativePath: (file) => file,
        createBackend: () => ({
          server: { timeoutMs: 1000 },
          _parse: (raw) => JSON.parse(raw) as P.Reply,
          _openSession() {
            throw new Error("Unexpected session");
          },
          listTools() {
            throw new Error("Unexpected catalog");
          },
          executeUiGuardedScript() {
            throw new Error("Unexpected script");
          },
          _post() {
            throw new Error("Replay forbidden");
          },
          async callTool(args) {
            probes++;
            await assert.rejects(
              originalServe(f.next, {
                dir: f.dir,
                confirmOwnership: true,
                autoReconcile: false,
                backendTransition: approval,
                createBackend() {
                  throw new Error(
                    "Competing upgrade must not construct a physical client",
                  );
                },
              }),
            );
            assert.ok(args.object?.script);
            return {
              failed: false,
              text: runBoundInstanceProbe(args.object.script, observation).text,
            };
          },
        }),
      });
      return handle;
    };
    for (const invalid of [
      { ...approval, clientToken: "foreign" },
      { ...approval, nextBuildHash: "b".repeat(64) },
      { ...approval, nextBuildHash: undefined },
      { ...approval, stopRequestId: undefined },
      {
        ...approval,
        previousConfig: { ...f.next, url: "http://changed.invalid" },
      },
    ]) {
      fs.writeFileSync(approvalFile, JSON.stringify(invalid));
      await assert.rejects(
        queueCommand(
          [
            "transition-backend",
            "--backend-approval",
            approvalFile,
            "--confirm-ownership",
            "true",
          ],
          deps,
        ),
      );
      assert.equal(probes, 0, "invalid upgrade sends no SDK work");
      assert.deepEqual(
        fs.readFileSync(path.join(f.dir, "physical-backend-head.json")),
        originalHeadBytes,
      );
    }
    fs.writeFileSync(approvalFile, JSON.stringify(approval));
    assert.equal(
      await queueCommand(
        [
          "transition-backend",
          "--backend-approval",
          approvalFile,
          "--confirm-ownership",
          "true",
        ],
        deps,
      ),
      0,
    );
    assert.equal(probes, 1);
    assert.ok(handle);
    assert.equal(handle.status().paused, true);
    const next = lifecycle.backendHead(f.dir)!;
    assert.equal(next.identity.buildHash, qi.buildHash());
    assert.equal(next.identity.configHash, originalHead.identity.configHash);
    assert.deepEqual(next.identity.instance, originalHead.identity.instance);
    assert.equal(
      fs.existsSync(reopenedReceipt),
      false,
      "no source receipt is fabricated",
    );
    const upgradeProof = JSON.parse(
      fs.readFileSync(next.head.runtimeUpgrade!.path, "utf8"),
    ) as {
      sourceStartup: { kind: string; receiptReference: { path: string } };
    };
    assert.equal(upgradeProof.sourceStartup.kind, "pinned-head-reopen");
    assert.notEqual(
      upgradeProof.sourceStartup.receiptReference.path,
      reopenedReceipt,
    );
    assert.ok(
      next.head.observation.some((ref) => ref.path.endsWith(".receipt.json")),
      "the new target has its own bound physical startup receipt",
    );
    for (const entry of retained)
      assert.deepEqual(fs.readFileSync(entry.file), entry.bytes);
    assert.deepEqual(
      fs.readFileSync(
        path.join(
          f.dir,
          "physical-backend-transitions",
          approval.requestId,
          "predecessor-head.json",
        ),
      ),
      originalHeadBytes,
    );
    await handle.close();
    handle = undefined;
    await broker.serve(f.next, {
      dir: f.dir,
      confirmOwnership: true,
      autoReconcile: false,
    });
    assert.equal(
      probes,
      1,
      "matching upgraded head reopens without a new SDK probe",
    );
  },
);

test(
  "owner stop authorizes an ADDIN runtime upgrade and recovers orphan work through its authenticated live backend",
  { timeout: 30000 },
  async (t) => {
    const processBirth = (
      load("./queue-instance") as {
        processBirth(pid?: number): string;
      }
    ).processBirth;
    const sdk = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    await once(sdk, "spawn");
    t.after(() => {
      if (sdk.exitCode === null && sdk.signalCode === null) sdk.kill("SIGKILL");
    });
    assert.ok(sdk.pid);
    const oldSdk: P.Instance = {
      pid: sdk.pid,
      birth: processBirth(sdk.pid),
      version: "fixture",
    };
    const f = setup(oldSdk, "mcp", undefined, true);
    const originalStateHome = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = f.root;
    t.after(() => {
      if (originalStateHome === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = originalStateHome;
    });
    const { hash } = load("./queue-instance") as {
      hash(value: string | Uint8Array): string;
    };
    const credentialsDir = path.join(f.dir, "client-credentials");
    fs.mkdirSync(credentialsDir, { recursive: true });
    fs.writeFileSync(
      path.join(credentialsDir, `${hash(f.clientId)}.json`),
      JSON.stringify({ clientId: f.clientId, clientToken: f.token }),
      { mode: 0o600 },
    );
    const originalEpochIdentity = fs.readFileSync(
      path.join(f.epoch.root, "instance.json"),
    );
    const originalPointer = fs.readFileSync(
      path.join(f.dir, "isolated-admission-epoch.json"),
    );
    const originalHistory = fs.readFileSync(
      path.join(f.dir, "queue-state.json"),
    );
    const ownerScript = path.join(
      process.cwd(),
      "tests/fixtures/backend-transition-owner.cjs",
    );
    const repoRoot = path.resolve(__dirname, "..", "..");
    const targetIdentity = oldSdk;
    const targetObservation = {
      ...targetIdentity,
      activeCommand: "SelectCommand",
      documents: [],
    };
    const owner = spawn(
      process.execPath,
      [
        ownerScript,
        runtimeRoot,
        repoRoot,
        f.dir,
        JSON.stringify(f.next),
        JSON.stringify(targetObservation),
        JSON.stringify(f.approval),
        "a".repeat(64),
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const children: ReturnType<typeof spawn>[] = [owner, sdk];
    const resources: { handle?: Awaited<ReturnType<typeof serve>> } = {};
    t.after(async () => {
      for (const child of children)
        if (child && child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      await Promise.all(
        children
          .filter(
            (child) => child.exitCode === null && child.signalCode === null,
          )
          .map((child) => once(child, "exit").catch(() => [])),
      );
      if (resources.handle) await resources.handle.close().catch(() => {});
      fs.rmSync(f.root, { recursive: true, force: true });
    });
    function waitForMessage(
      child: ReturnType<typeof spawn>,
      kind: string,
    ): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const onMessage = (value: unknown) => {
          const message = value as Record<string, unknown>;
          if (message["kind"] === "error") {
            child.off("message", onMessage);
            reject(
              Object.assign(new Error(String(message["message"])), message),
            );
          } else if (message["kind"] === kind) {
            child.off("message", onMessage);
            resolve(message);
          }
        };
        child.on("message", onMessage);
        child.once("exit", (code) => {
          child.off("message", onMessage);
          reject(new Error(`Owner exited before ${kind} (code ${code})`));
        });
      });
    }
    async function waitForFile(file: string) {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(file) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(
        fs.existsSync(file),
        `Timed out waiting for ${path.basename(file)}`,
      );
    }

    const ready = waitForMessage(owner, "ready");
    assert.equal((await ready)["kind"], "ready");
    const sourceOwner = JSON.parse(
      fs.readFileSync(path.join(f.dir, "broker.lock"), "utf8"),
    ) as { nonce: string };
    const sourceStartupReceipt = path.join(
      f.dir,
      `broker-startup-${sourceOwner.nonce}.receipt.json`,
    );
    assert.ok(
      fs.existsSync(sourceStartupReceipt),
      JSON.stringify(
        fs.readdirSync(f.dir).filter((name) => name.startsWith("broker-")),
      ),
    );

    let stdout = "";
    const cliDeps = {
      loadConfig: () => ({ cfg: f.next }),
      stdout: {
        write(text: string) {
          stdout += text;
        },
      },
      stderr: { write() {} },
    };
    const { queueCommand } = load("./dist/entrypoints/queue-cli") as {
      queueCommand(argv: string[], deps: typeof cliDeps): Promise<number>;
    };
    const stopRequestId = "addin-runtime-owner-stop";
    assert.equal(
      await queueCommand(
        ["stop", "--client", f.clientId, "--request-id", stopRequestId],
        cliDeps,
      ),
      0,
    );
    const releaseFile = String(JSON.parse(stdout)["releaseFile"]);
    await waitForFile(releaseFile);
    const ownerExit = once(owner, "exit");
    owner.send({ action: "exit" });
    await ownerExit;
    assert.ok(fs.existsSync(sourceStartupReceipt));
    const sourceState = (
      load("./queue-isolated-epoch") as {
        openIsolatedEpoch(dir: string, options: { recover: false }): P.State;
      }
    ).openIsolatedEpoch(f.dir, { recover: false });
    const jobsAtTransition = Object.fromEntries(
      Object.entries(sourceState.data.jobs).map(([id, job]) => [id, job.state]),
    );

    let targetProbes = 0;
    let probeStarted!: () => void;
    let continueProbe!: () => void;
    const firstProbeStarted = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    const firstProbeAllowed = new Promise<void>((resolve) => {
      continueProbe = resolve;
    });
    const approval: BackendTransitionApproval = {
      ...f.approval,
      requestId: "addin-runtime-upgrade-after-owner-stop",
      previousConfig: f.next,
      nextConfig: f.next,
      stopRequestId,
      nextBuildHash: (
        load("./queue-instance") as { buildHash(): string }
      ).buildHash(),
    };
    const approvalFile = path.join(f.root, "backend-approval.json");
    fs.writeFileSync(approvalFile, JSON.stringify(approval), { mode: 0o600 });
    const broker = load("./queue-broker") as {
      serve: typeof serve;
    };
    const productionServe = broker.serve;
    const createBackend = (): P.Client => ({
      server: { timeoutMs: 1000 },
      _parse: (raw) => JSON.parse(raw) as P.Reply,
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
      callTool: async (args) => {
        targetProbes++;
        if (targetProbes === 1) {
          probeStarted();
          await firstProbeAllowed;
        }
        assert.ok(args.object?.script);
        return {
          failed: false,
          text: runBoundInstanceProbe(args.object.script, targetObservation)
            .text,
        };
      },
    });
    const transitionOptions: P.Options = {
      dir: f.dir,
      confirmOwnership: true,
      autoReconcile: false,
      nativePath: (file) => file,
      backendTransition: approval,
      createBackend,
    };
    broker.serve = async (config, options) => {
      const handle = await productionServe(config, {
        ...options,
        dir: f.dir,
        nativePath: (file) => file,
        createBackend,
      });
      resources.handle = handle;
      return handle;
    };
    t.after(() => {
      broker.serve = productionServe;
    });
    stdout = "";
    const winner = queueCommand(
      [
        "transition-backend",
        "--backend-approval",
        approvalFile,
        "--confirm-ownership",
        "true",
      ],
      { ...cliDeps, loadConfig: () => ({ cfg: f.next }) },
    );
    await Promise.race([
      firstProbeStarted,
      winner.then(() => {
        throw new Error(
          "Transition completed without reaching its target probe",
        );
      }),
    ]);
    try {
      await assert.rejects(serve(f.next, transitionOptions));
      assert.equal(targetProbes, 1, "the competing startup never probes ADDIN");
    } finally {
      continueProbe();
    }
    assert.equal(await winner, 0);
    const handle = resources.handle;
    assert.ok(handle);
    assert.equal(
      targetProbes,
      1,
      "transition performs one ADDIN startup probe",
    );
    assert.equal(
      handle.status().paused,
      true,
      "owner stop pause remains closed",
    );
    const head = JSON.parse(
      fs.readFileSync(path.join(f.dir, "physical-backend-head.json"), "utf8"),
    ) as { identity: { path: string } };
    const activeIdentity = JSON.parse(
      fs.readFileSync(head.identity.path, "utf8"),
    ) as P.Identity;
    assert.deepEqual(
      {
        pid: activeIdentity.instance.pid,
        birth: activeIdentity.instance.birth,
        version: activeIdentity.instance.version,
      },
      targetIdentity,
    );
    assert.equal(activeIdentity.instance.activeCommand, "SelectCommand");
    assert.deepEqual(activeIdentity.instance.documents, []);
    assert.deepEqual(
      fs.readFileSync(path.join(f.epoch.root, "instance.json")),
      originalEpochIdentity,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(f.dir, "isolated-admission-epoch.json")),
      originalPointer,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(f.dir, "queue-state.json")),
      originalHistory,
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(handle.status().jobs).map(([id, job]) => [
          id,
          job.state,
        ]),
      ),
      jobsAtTransition,
    );

    stdout = "";
    assert.equal(
      await queueCommand(
        [
          "resume",
          "--client",
          f.clientId,
          "--request-id",
          "resume-after-addin-runtime-upgrade",
        ],
        { ...cliDeps, loadConfig: () => ({ cfg: f.next }) },
      ),
      0,
    );
    assert.equal(handle.status().paused, false);
    assert.equal(
      targetProbes,
      2,
      "resume is a separate fresh ADDIN observation",
    );
    const { createQueueSession } = load("./dist/composition/library-queue") as {
      createQueueSession(
        config: P.Config,
        clientId: string,
        cwd: string,
        instanceId: string,
      ): {
        start(): Promise<void>;
        status(): Promise<{ blocked: boolean }>;
        dispose(): void;
      };
    };
    const session = createQueueSession(
      f.next,
      f.clientId,
      f.root,
      "transition-public-client",
    );
    try {
      await session.start();
      assert.equal((await session.status()).blocked, false);
      const headFile = path.join(f.dir, "physical-backend-head.json");
      const retainedHead = fs.readFileSync(headFile);
      try {
        const altered = JSON.parse(retainedHead.toString()) as {
          identity: { sha256: string };
        };
        altered.identity.sha256 = "0".repeat(64);
        fs.writeFileSync(headFile, JSON.stringify(altered));
        await assert.rejects(session.status(), {
          code: "BACKEND_TRANSITION_CHANGED",
        });
      } finally {
        fs.writeFileSync(headFile, retainedHead);
      }
    } finally {
      session.dispose();
    }
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(handle.status().jobs).map(([id, job]) => [
          id,
          job.state,
        ]),
      ),
      jobsAtTransition,
    );
    await handle.close();
    delete resources.handle;
    const { openIsolatedEpoch } = load("./queue-isolated-epoch") as {
      openIsolatedEpoch(dir: string, options?: { recover: false }): P.State;
    };
    const current = openIsolatedEpoch(f.dir, { recover: false });
    const job = current.submit({
      kind: "rpc",
      requestId: "interrupted-after-authenticated-backend-transition",
      clientId: f.clientId,
      timeoutMs: 1000,
      payload: { jsonrpc: "2.0", id: "orphan-write", method: "tools/call" },
    });
    const jobId = job["id"];
    assert.ok(typeof jobId === "string");
    assert.equal(current.next()?.id, jobId);
    assert.equal(current.status(jobId)["state"], "running");
    const currentFile = path.join(f.epoch.root, "queue-state.json");
    const interruptedBytes = fs.readFileSync(currentFile);
    const retained = [
      path.join(f.dir, "queue-state.json"),
      path.join(f.dir, "instance.json"),
      path.join(f.epoch.root, "instance.json"),
      path.join(f.dir, "isolated-admission-epoch.json"),
      path.join(f.dir, "physical-backend-head.json"),
      head.identity.path,
    ].map((file) => ({ file, bytes: fs.readFileSync(file) }));
    const readonly = openIsolatedEpoch(f.dir, { recover: false });
    assert.equal(readonly.status(jobId)["state"], "running");
    assert.deepEqual(fs.readFileSync(currentFile), interruptedBytes);
    const backend = lifecycle.resolveBackendHead(f.dir, () => readonly).current;
    assert.ok(backend);
    assert.equal(backend.identity.instance.pid, targetIdentity.pid);
    assert.equal(backend.identity.instance.birth, targetIdentity.birth);
    assert.equal(backend.identity.instance.pid, f.epoch.currentInstance.pid);
    const reopened = openIsolatedEpoch(f.dir);
    assert.equal(reopened.status(jobId)["state"], "needs_reconciliation");
    assert.equal(reopened.summary().blocked?.id, jobId);
    assert.equal(
      targetProbes,
      2,
      "metadata recovery neither probes Fusion nor replays dispatched work",
    );
    for (const { file, bytes } of retained)
      assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(
      fs.readFileSync(path.join(f.dir, "queue-state.json")),
      originalHistory,
    );
  },
);

function publishedSetup(t: TestContext) {
  const fixtureLoad = createRequire(
    path.join(process.cwd(), "tests/queue-backend-transition.test.js"),
  );
  t.after(
    (fixtureLoad("./fixtures/fake-wsl-platform.cjs") as () => () => void)(),
  );
  const root = fs.mkdtempSync(path.join(tmpdir(), "fmcad-retired-backend-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = (
    fixtureLoad("./fixtures/backend-successor.cjs") as (
      base: string,
      repo: string,
    ) => DeadEpochFixture & {
      headFile: string;
      transition: string;
      publish(): {
        pointer: FixturePointer;
        identity: DeadEpochFixture["identity"];
        entry: { path: string; sha256: string };
        authority: DeadEpochFixture["authority"];
      };
    }
  )(root, runtimeRoot);
  const published = f.publish();
  const { openIsolatedEpoch } = load("./queue-isolated-epoch") as {
    openIsolatedEpoch(dir: string, options: { recover: false }): P.State;
  };
  return {
    ...f,
    root,
    published,
    readState: () => openIsolatedEpoch(f.dir, { recover: false }),
  };
}

test("a published successor resolves only the exact authenticated historical backend head", (t) => {
  const f = publishedSetup(t);
  const original = fs.readFileSync(f.headFile);
  assert.throws(() => lifecycle.backendHead(f.dir), {
    code: "BACKEND_TRANSITION_CHANGED",
  });
  const resolved = lifecycle.resolveBackendHead(f.dir, f.readState);
  assert.equal(resolved.current, null);
  assert.ok(resolved.retired);
  assert.equal(
    resolved.retired.identityFile,
    path.join(f.published.pointer.root, "instance.json"),
  );
  assert.deepEqual(resolved.retired.authority, f.published.entry);
  assert.deepEqual(
    resolved.retired.transition,
    f.published.authority.backendTransition?.head,
  );
  assert.deepEqual(fs.readFileSync(f.headFile), original);
  const missing = f.headFile + ".test-backup";
  fs.renameSync(f.headFile, missing);
  try {
    assert.throws(() => lifecycle.resolveBackendHead(f.dir, f.readState), {
      code: "BACKEND_TRANSITION_CHANGED",
    });
    fs.symlinkSync(missing, f.headFile);
    try {
      assert.throws(() => lifecycle.resolveBackendHead(f.dir, f.readState), {
        code: "BACKEND_TRANSITION_CHANGED",
      });
    } finally {
      fs.unlinkSync(f.headFile);
    }
  } finally {
    fs.renameSync(missing, f.headFile);
  }
  const changed = JSON.parse(original.toString("utf8")) as {
    requestId: string;
  };
  changed.requestId = "foreign-head";
  fs.writeFileSync(f.headFile, JSON.stringify(changed));
  try {
    assert.throws(() => lifecycle.resolveBackendHead(f.dir, f.readState), {
      code: "BACKEND_TRANSITION_CHANGED",
    });
  } finally {
    fs.writeFileSync(f.headFile, original);
  }
});

test("a backend restore after succession starts a new epoch chain without old-SDK escrow", (t) => {
  const f = publishedSetup(t);
  const priorHead = path.join(f.transition, "transition.json");
  const protectedFiles = [
    priorHead,
    f.published.entry.path,
    path.join(f.inspection.pointer.root, "queue-state.json"),
  ];
  const original = protectedFiles.map((file) => fs.readFileSync(file));
  const closed = createRequire(
    path.join(process.cwd(), "tests/queue-backend-transition.test.js"),
  )(
    "./fixtures/closed-scratch-artifacts.cjs",
  ) as typeof import("./fixtures/closed-scratch-artifacts.cjs");
  closed(f.dir, f.published.pointer, runtimeRoot, "normal-multidocument");
  const state = f.readState();
  const next = {
    ...f.cfg,
    backend: "addin",
    url: "http://127.0.0.1:1/never-called-addin",
  };
  const prepared = lifecycle.prepareBackendTransition(f.dir, state, next, {
    requestId: "restored-after-successor",
    clientId: f.clientId,
    clientToken: f.token,
    previousConfig: f.cfg,
    nextConfig: next,
  });
  prepared.commit(
    {
      ...f.published.identity.instance,
      activeCommand: "SelectCommand",
      documents: [],
    },
    f.published.identity.buildHash,
  );
  const result = lifecycle.resolveBackendHead(f.dir, f.readState);
  assert.equal(result.retired, null);
  assert.ok(result.current);
  assert.equal(
    result.current.identity.configHash,
    load("./queue-instance").brokerConfigHash(next),
  );
  assert.ok(
    result.current.head.predecessor.some(
      (ref) =>
        ref.path === f.published.entry.path &&
        ref.sha256 === f.published.entry.sha256,
    ),
  );
  assert.ok(
    result.current.head.predecessor.some(
      (ref) => ref.path === f.published.authority.backendTransition?.head.path,
    ),
  );
  assert.equal(
    fs.existsSync(
      path.join(
        f.dir,
        "physical-backend-transitions/restored-after-successor/predecessor-head.json",
      ),
    ),
    false,
  );
  for (const [index, file] of protectedFiles.entries())
    assert.deepEqual(fs.readFileSync(file), original[index]);
});

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
    const targetHead = lifecycle.backendHead(f.dir)!;
    assert.equal(
      targetHead.identity.configHash,
      load("./queue-instance").brokerConfigHash(f.next),
    );
    const targetBytes = fs.readFileSync(targetHead.identityFile);
    // This inverse round-trip exercises transition metadata only; it never starts a broker or backend.
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
    assert.deepEqual(fs.readFileSync(targetHead.identityFile), targetBytes);
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

test("FAKE recovery: local worker exit cannot authorize a backend transition over an unresolved SDK turn", async () => {
  const f = setup();
  try {
    const job = f.state.submit({
      kind: "rpc",
      requestId: "owned-unresolved-write",
      clientId: f.clientId,
      timeoutMs: 1000,
      payload: { jsonrpc: "2.0", id: "synthetic-write", method: "tools/call" },
    });
    const jobId = job["id"];
    assert.ok(typeof jobId === "string");
    f.state.next();
    f.state.markDispatch(jobId, { rpcCount: 1, completedCount: 0 });
    f.state.block(jobId, { code: "UNKNOWN_RPC" });
    const directory = path.join(f.dir, "jobs", jobId);
    fs.mkdirSync(directory, { recursive: true });
    const workerFile = path.join(directory, "worker-result.json");
    const rpcFile = path.join(directory, "rpc-synthetic-unresolved.json");
    const remoteReceipt = path.join(
      directory,
      "remote-synthetic-unresolved.json",
    );
    fs.writeFileSync(
      workerFile,
      JSON.stringify({ jobId, code: 1, terminal: true }),
    );
    fs.writeFileSync(
      rpcFile,
      JSON.stringify({
        binding: { jobId, rpcId: "synthetic-unresolved" },
        instance: f.epoch.currentInstance,
        receipt: remoteReceipt,
        terminal: false,
      }),
    );
    const protectedFiles = [
      path.join(f.dir, "queue-state.json"),
      path.join(f.dir, "instance.json"),
      path.join(f.epoch.root, "queue-state.json"),
      path.join(f.epoch.root, "instance.json"),
      path.join(f.dir, "isolated-admission-epoch.json"),
      workerFile,
      rpcFile,
    ].map((file) => ({ file, bytes: fs.readFileSync(file) }));
    let physicalClients = 0;
    await assert.rejects(
      serve(f.next, {
        dir: f.dir,
        confirmOwnership: true,
        backendTransition: f.approval,
        createBackend() {
          physicalClients++;
          throw new Error(
            "An unresolved SDK turn must not construct a transport",
          );
        },
      }),
      { code: "EPOCH_BUSY" },
    );
    assert.equal(physicalClients, 0);
    assert.equal(fs.existsSync(remoteReceipt), false);
    assert.equal(fs.existsSync(path.join(f.dir, "broker.lock")), false);
    assert.equal(
      fs.existsSync(path.join(f.dir, "physical-backend-head.json")),
      false,
    );
    assert.equal(f.state.status(jobId)["state"], "needs_reconciliation");
    for (const { file, bytes } of protectedFiles)
      assert.deepEqual(fs.readFileSync(file), bytes);
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

test(
  "public result reader waits for the actual snapshot writer without replay or pending recovery",
  { timeout: 20000 },
  async (t) => {
    const f = setup(undefined, "mcp", undefined, true);
    const home = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = f.root;
    t.after(() => {
      if (home === undefined) delete process.env["XDG_STATE_HOME"];
      else process.env["XDG_STATE_HOME"] = home;
    });
    const qi = load("./queue-instance") as { hash(value: string): string };
    fs.mkdirSync(path.join(f.dir, "client-credentials"), { recursive: true });
    fs.writeFileSync(
      path.join(f.dir, "client-credentials", `${qi.hash(f.clientId)}.json`),
      JSON.stringify({ clientId: f.clientId, clientToken: f.token }),
      { mode: 0o600 },
    );
    let probes = 0;
    const observation = {
      ...f.epoch.currentInstance,
      activeCommand: "SelectCommand",
      documents: [],
    };
    const handle = await serve(f.next, {
      dir: f.dir,
      confirmOwnership: true,
      autoReconcile: false,
      nativePath: (file) => file,
      backendTransition: f.approval,
      createBackend: () => ({
        server: { timeoutMs: 1000 },
        _parse: (raw) => JSON.parse(raw) as P.Reply,
        _openSession() {
          throw new Error("Unexpected session");
        },
        listTools() {
          throw new Error("Unexpected catalog");
        },
        executeUiGuardedScript() {
          throw new Error("Unexpected script");
        },
        _post() {
          throw new Error("Replay forbidden");
        },
        async callTool(args) {
          probes++;
          assert.ok(args.object?.script);
          return {
            failed: false,
            text: runBoundInstanceProbe(args.object.script, observation).text,
          };
        },
      }),
    });
    t.after(async () => {
      await handle.close();
      fs.rmSync(f.root, { recursive: true, force: true });
    });
    const { createQueueSession } = load("./dist/composition/library-queue") as {
      createQueueSession(
        config: P.Config,
        clientId: string,
        cwd: string,
        instanceId: string,
      ): {
        start(): Promise<void>;
        result(jobId: string): Promise<unknown>;
        dispose(): void;
      };
    };
    const session = createQueueSession(
      f.next,
      f.clientId,
      f.root,
      "snapshot-reader",
    );
    t.after(() => session.dispose());
    await session.start();
    const job = Object.values(handle.status().jobs).find(
      (job) => job.state === "succeeded",
    )!;
    assert.ok(job);
    const original = await session.result(job.id);
    const foreign = createQueueSession(
      f.next,
      "foreign-result-reader",
      f.root,
      "foreign-reader",
    );
    try {
      await foreign.start();
      await assert.rejects(foreign.result(job.id), { code: "NOT_OWNER" });
    } finally {
      foreign.dispose();
    }
    const stateFile = path.join(f.epoch.root, "queue-state.json");
    const bytes = fs.readFileSync(stateFile);
    const releaseFile = path.join(f.root, "release-writer");
    const writer = spawn(
      process.execPath,
      [
        path.join(process.cwd(), "tests/fixtures/held-snapshot-commit.cjs"),
        runtimeRoot,
        f.epoch.root,
        releaseFile,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    t.after(async () => {
      if (writer.exitCode === null && writer.signalCode === null) {
        const exit = once(writer, "exit");
        writer.kill("SIGKILL");
        await exit;
      }
    });
    await new Promise<void>((resolve, reject) => {
      writer.on("message", (message: { kind: string; message?: string }) => {
        if (message.kind === "pending") resolve();
        if (message.kind === "error") reject(new Error(message.message));
      });
      writer.once("exit", () =>
        reject(new Error("Writer exited before pending")),
      );
    });
    assert.ok(
      fs.existsSync(path.join(f.epoch.root, "queue-state.pending.json")),
    );
    const exit = once(writer, "exit");
    const release = setTimeout(
      () => fs.writeFileSync(releaseFile, "release"),
      50,
    );
    try {
      assert.deepEqual(await session.result(job.id), original);
    } finally {
      clearTimeout(release);
      fs.writeFileSync(releaseFile, "release");
      await exit;
    }
    assert.deepEqual(fs.readFileSync(stateFile), bytes);
    assert.equal(
      fs.existsSync(path.join(f.epoch.root, "queue-state.pending.json")),
      false,
    );
    assert.equal(probes, 1, "result read never replays an SDK request");
    const headFile = path.join(f.dir, "physical-backend-head.json");
    const headBytes = fs.readFileSync(headFile);
    try {
      const changed = JSON.parse(headBytes.toString()) as {
        identity: { sha256: string };
      };
      changed.identity.sha256 = "0".repeat(64);
      fs.writeFileSync(headFile, JSON.stringify(changed));
      await assert.rejects(session.result(job.id), {
        code: "BACKEND_TRANSITION_CHANGED",
      });
    } finally {
      fs.writeFileSync(headFile, headBytes);
    }
    const { createSnapshotStore } = load(
      "./dist/node-adapters/persistence/records",
    ) as typeof import("../packages/node-adapters/src/persistence/records");
    const pendingFile = path.join(f.epoch.root, "queue-state.pending.json");
    const broken = createSnapshotStore(f.epoch.root, {
      ...fs,
      unlinkSync(file) {
        if (file === pendingFile) throw new Error("fixture ambiguous unlink");
        fs.unlinkSync(file);
      },
    });
    assert.throws(() => broken.commit(bytes.toString()), {
      code: "STORAGE_UNAVAILABLE",
    });
    const pendingBytes = fs.readFileSync(pendingFile);
    const clients = fs.readFileSync(path.join(f.dir, "clients.json"));
    const stalled = createQueueSession(
      { ...f.next, timeoutMs: 30 },
      "never-register-unresolved",
      f.root,
      "stalled-reader",
    );
    try {
      await assert.rejects(stalled.start(), { code: "EPOCH_PROOF_INVALID" });
      assert.deepEqual(
        fs.readFileSync(pendingFile),
        pendingBytes,
        "reader never recovers or removes the unresolved marker",
      );
      assert.deepEqual(
        fs.readFileSync(path.join(f.dir, "clients.json")),
        clients,
        "unresolved fence precedes registration",
      );
    } finally {
      stalled.dispose();
      fs.unlinkSync(pendingFile); // Explicit cleanup of this synthetic fault fixture only.
    }
  },
);

test("sole broker probes a supported ADDIN target once and reopens its matching head without an SDK probe", async () => {
  const f = setup();
  let probes = 0;
  let handle: Awaited<ReturnType<typeof serve>> | undefined;
  const originalIdentity = fs.readFileSync(
    path.join(f.epoch.root, "instance.json"),
  );
  const archivedIdentity = fs.readFileSync(path.join(f.dir, "instance.json"));
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
      callTool: async (args) => {
        probes++;
        assert.ok(args.object?.script);
        return {
          failed: false,
          text: runBoundInstanceProbe(args.object.script, observation).text,
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
    assert.equal(
      lifecycle.backendHead(f.dir)?.identity.configHash,
      load("./queue-instance").brokerConfigHash(f.next),
    );
    assert.deepEqual(
      fs.readFileSync(path.join(f.dir, "instance.json")),
      archivedIdentity,
    );
    assert.equal(probes, 1, "the archived MCP predecessor is never reopened");
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
  const f = setup(undefined, "mcp");
  let handle: Awaited<ReturnType<typeof serve>> | undefined;
  let probes = 0;
  let ownerProbes = 0;
  const observation = {
    ...f.epoch.currentInstance,
    activeCommand: "SelectCommand",
    documents: [],
  };
  const owner = spawn(
    process.execPath,
    [
      path.join(process.cwd(), "tests/fixtures/backend-transition-owner.cjs"),
      runtimeRoot,
      process.cwd(),
      f.dir,
      JSON.stringify(f.next),
      JSON.stringify(observation),
      JSON.stringify(f.approval),
      "a".repeat(64),
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const ownerReady = new Promise<void>((resolve, reject) => {
    owner.on("message", (raw: unknown) => {
      const message = raw as { kind: string; message?: string };
      if (message.kind === "probe") ownerProbes++;
      else if (message.kind === "ready") resolve();
      else if (message.kind === "error")
        reject(new Error(message.message || "Backend-transition owner failed"));
    });
    owner.once("exit", () =>
      reject(new Error("Owner exited before becoming ready")),
    );
  });
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
      callTool: async (args) => {
        probes++;
        assert.ok(args.object?.script);
        return {
          failed: false,
          text: runBoundInstanceProbe(args.object.script, observation).text,
        };
      },
    }),
  };
  try {
    await ownerReady;
    assert.equal(ownerProbes, 1);
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
    const releaseFile = String(stopped["releaseFile"]);
    const ownerExit = once(owner, "exit");
    owner.send({ action: "exit" });
    await ownerExit;
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
      serve(f.next, {
        ...options,
        backendTransition: f.approval,
      }),
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
    const qi = load("./queue-instance") as { buildHash(): string };
    handle = await serve(f.next, {
      ...options,
      backendTransition: {
        ...f.approval,
        requestId: "actual-owner-stop-runtime-upgrade",
        previousConfig: f.next,
        nextConfig: f.next,
        stopRequestId: "actual-owner-stop",
        nextBuildHash: qi.buildHash(),
      },
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
      serve(f.next, {
        ...options,
        backendTransition: {
          ...f.approval,
          requestId: "cannot-reuse-stop",
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
    if (owner.exitCode === null && owner.signalCode === null) {
      const exit = once(owner, "exit");
      owner.kill("SIGKILL");
      await exit;
    }
    if (handle) await handle.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
