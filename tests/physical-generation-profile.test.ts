import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import childProcess, { type SpawnOptions } from "node:child_process";
import test from "node:test";
import { physicalBrokerPortsFromEnvironment } from "../packages/node-adapters/src/execution/physical-generation-profile";
import { PhysicalGenerationProvisionError } from "../packages/node-adapters/src/execution/physical-generation-provision";
import type { PhysicalGenerationDescriptor } from "../packages/node-adapters/src/execution/physical-generation";
import {
  DEFAULT_ADDIN_SETTINGS,
  type FmcadConfiguration,
} from "../packages/core/src/domain/config";

const linux = {
  skip: process.platform !== "linux" && "Linux/WSL private physical profile",
};

function fixture(t: { after(action: () => void): void }) {
  const root = fs.mkdtempSync("/tmp/opencode/physical-profile-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = {
    version: 1,
    clientId: "physical-broker",
    transport: "node",
    runtime: {
      kind: "fmcad-physical-grant",
      version: 1,
      handoffId: "committed-handoff",
      generation: { instance: "native-instance", epoch: "native-generation" },
      endpointURL: "http://127.0.0.1:8765/mcp",
      physicalRuntime: {
        pid: 42,
        birth: "observed-native-birth",
        version: "native-version",
        source: "fork-source",
        build: "archive-sha",
      },
    },
    nativeProvision: {
      nativePython: "C:\\Python\\python.exe",
      mappedNativePython: "/mnt/c/Python/python.exe",
      nativePythonSha256: "a".repeat(64),
      installedForkDirectory: "C:\\AddIns\\AutodeskFusionMCP",
      mappedInstalledForkDirectory: "/mnt/c/AddIns/AutodeskFusionMCP",
      installedPackageFiles: { "addon_runtime.py": "b".repeat(64) },
      provisionPath: "C:\\private\\provision.json",
      localAppData: "C:\\private",
      nativePrivateDirectory: "C:\\private\\requests",
      mappedPrivateDirectory: "/mnt/c/private/requests",
      linuxGrantDirectory: root,
      timeoutMs: 10000,
    },
  };
  const file = path.join(root, "operator.json");
  function publish() {
    fs.writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
  }
  publish();
  return { root, profile, file, publish };
}

test("native runtime configuration is saved under the owner claim and reused without environment", linux, async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "runtime-rebaseline-head.json"), "{}");
  const configured = path.join(f.root, "runtime-physical-profile.json");
  let verified = false;
  let ownerChecks = 0;
  let provisions = 0;
  const dependencies: NonNullable<Parameters<typeof physicalBrokerPortsFromEnvironment>[1]> = {
    directory: f.root,
    runtimeRootFactory(profile) {
      return {
        nativeProvision: profile.nativeProvision,
        async verifyRuntimeRootBeforeRestore() { verified = true; return {}; },
        assertVerifiedRoot(directory) { assert.equal(directory, f.root); assert.equal(verified, true); },
        async getVerifiedActivation() { return undefined; },
      };
    },
    provisionFactory() {
      return { async provision() { provisions++; throw new PhysicalGenerationProvisionError("notStarted"); } };
    },
  };
  const ports = physicalBrokerPortsFromEnvironment(
    { FMCAD_PHYSICAL_OPERATOR_PROFILE: f.file }, dependencies,
  );
  assert.ok(ports);
  assert.equal(fs.existsSync(configured), false, "loading a profile is not an owner claim");
  await ports.verifyRuntimeRootBeforeRestore({ directory: f.root, buildHash: "a".repeat(64), configHash: "b".repeat(64) });
  await assert.rejects(ports.preparePhysicalGeneration({
    directory: f.root,
    owner: { pid: process.pid, birth: "owned-broker-birth", nonce: "claimed-owner" },
    buildHash: "a".repeat(64), configHash: "b".repeat(64),
    assertBrokerOwner() { ownerChecks++; },
  }), { code: "PHYSICAL_GENERATION_REJECTED", notStarted: true });
  assert.ok(ownerChecks >= 2);
  assert.equal(provisions, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(configured, "utf8")), f.profile);
  assert.equal(fs.statSync(configured).mode & 0o777, 0o600);
  verified = false;
  const restored = physicalBrokerPortsFromEnvironment({}, dependencies);
  assert.ok(restored, "ordinary startup discovers the saved runtime configuration");
  await restored.verifyRuntimeRootBeforeRestore({ directory: f.root, buildHash: "a".repeat(64), configHash: "b".repeat(64) });
  assert.equal(verified, true, "saved configuration still needs authenticated root verification");
  fs.chmodSync(configured, 0o644);
  assert.throws(() => physicalBrokerPortsFromEnvironment({}, dependencies), {
    code: "PHYSICAL_OPERATOR_PROFILE_REJECTED",
  });
});

test("native runtime configuration is not published after losing the owner", linux, async t => {
  const f = fixture(t);
  const configured = path.join(f.root, "runtime-physical-profile.json");
  const ports = physicalBrokerPortsFromEnvironment(
    { FMCAD_PHYSICAL_OPERATOR_PROFILE: f.file },
    {
      runtimeRootFactory(profile) {
        return {
          nativeProvision: profile.nativeProvision,
          async verifyRuntimeRootBeforeRestore() { return {}; },
          assertVerifiedRoot() {},
          async getVerifiedActivation() { return undefined; },
        };
      },
      provisionFactory() { assert.fail("No provisioning after owner loss"); },
    },
  );
  assert.ok(ports);
  await assert.rejects(ports.preparePhysicalGeneration({
    directory: f.root,
    owner: { pid: process.pid, birth: "old-owner", nonce: "lost-owner" },
    buildHash: "a".repeat(64), configHash: "b".repeat(64),
    assertBrokerOwner() { throw new Error("Owner changed"); },
  }), /Owner changed/);
  assert.equal(fs.existsSync(configured), false);
});

test(
  "serve rejects an invalid private profile and mixed authority before backend creation",
  linux,
  async (t) => {
    const f = fixture(t);
    const old = process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"];
    process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"] = f.file;
    t.after(() => {
      if (old === undefined)
        delete process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"];
      else process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"] = old;
    });
    const load = createRequire(path.resolve(__dirname, "../../package.json"));
    const broker: typeof import("../src/composition/queue-broker") = load(
      path.resolve(__dirname, "../../src/queue-broker.js"),
    );
    const cfg: FmcadConfiguration = {
      ...DEFAULT_ADDIN_SETTINGS,
      backend: "addin",
      routing: "queue",
      queue: { autoStart: false },
      controlCenter: { port: 4748 },
    };
    let backendCalls = 0;
    const createBackend = () => {
      backendCalls++;
      throw new Error("Backend must not be constructed");
    };
    await assert.rejects(
      broker.serve(
        { ...cfg },
        {
          createBackend,
          authorizePhysicalRequest() {
            return {};
          },
        },
      ),
      { code: "PHYSICAL_CAPABILITY_CONFLICT" },
    );
    fs.writeFileSync(f.file, "{}", { mode: 0o600 });
    await assert.rejects(broker.serve({ ...cfg }, { createBackend }), {
      code: "PHYSICAL_OPERATOR_PROFILE_REJECTED",
    });
    assert.equal(backendCalls, 0);
  },
);

test(
  "serve prepares environment capabilities only under the real owner and aborts before backend initialization",
  linux,
  async (t) => {
    const f = fixture(t);
    const old = process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"];
    process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"] = f.file;
    t.after(() => {
      if (old === undefined)
        delete process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"];
      else process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"] = old;
    });
    const load = createRequire(path.resolve(__dirname, "../../package.json"));
    const broker: typeof import("../src/composition/queue-broker") = load(
      path.resolve(__dirname, "../../src/queue-broker.js"),
    );
    const profileModule: typeof import("../packages/node-adapters/src/execution/physical-generation-profile") =
      load(
        path.resolve(
          __dirname,
        "../../src/dist/node-adapters/execution/physical-generation-profile.js",
        ),
      );
    const original = profileModule.physicalBrokerPortsFromEnvironment;
    const directory = path.join(f.root, "owned-queue");
    let preparations = 0;
    let backendCalls = 0;
    t.mock.method(profileModule, "physicalBrokerPortsFromEnvironment", () => {
      const ports = original(process.env, {
        provisionFactory: () => ({
          async provision() {
            throw new Error("The composition fixture does not issue grants");
          },
        }),
      });
      assert.ok(ports);
      return {
        ...ports,
        async preparePhysicalGeneration(
          context: Parameters<typeof ports.preparePhysicalGeneration>[0],
        ) {
          preparations++;
          assert.equal(context.directory, fs.realpathSync(directory));
          assert.equal(context.owner.pid, process.pid);
          context.assertBrokerOwner();
          throw Object.assign(new Error("Owned post-claim fixture"), {
            code: "OFFLINE_POSTCLAIM_CAPTURED",
            // This private fixture never invokes the issuer. Generic failures
            // cannot claim this classification and must retain the owner.
            notStarted: true,
          });
        },
      };
    });
    await assert.rejects(
      broker.serve(
        {
          ...DEFAULT_ADDIN_SETTINGS,
          backend: "addin",
          routing: "queue",
          queue: { autoStart: false },
          controlCenter: { port: 4748 },
        },
        {
          dir: directory,
          confirmOwnership: true,
          createBackend() {
            backendCalls++;
            throw new Error(
              "Backend must not initialize after preparation failure",
            );
          },
        },
      ),
      { code: "OFFLINE_POSTCLAIM_CAPTURED" },
    );
    assert.equal(preparations, 1);
    assert.equal(backendCalls, 0);
    assert.equal(fs.existsSync(path.join(directory, "broker.lock")), false);
  },
);

test("ordinary public configuration does not provide physical operator authority", () => {
  let factories = 0;
  assert.equal(
    physicalBrokerPortsFromEnvironment(
      { FMCAD_CONFIG: "/public/config.json" },
      {
        provisionFactory() {
          factories++;
          assert.fail("Not a trusted operator profile");
        },
      },
    ),
    undefined,
  );
  assert.equal(factories, 0);
});

test(
  "normal broker autostart forwards only the private profile path, not arbitrary environment",
  linux,
  async (t) => {
    const f = fixture(t);
    const changes: Record<string, string | undefined> = {
      XDG_STATE_HOME: path.join(f.root, "state"),
      XDG_CONFIG_HOME: path.join(f.root, "config"),
      XDG_DATA_HOME: path.join(f.root, "data"),
      XDG_CACHE_HOME: path.join(f.root, "cache"),
      FMCAD_CONFIG: undefined,
      FMCAD_PHYSICAL_OPERATOR_PROFILE: f.file,
      FMCAD_PROFILE_TEST_SECRET: "must-not-reach-the-daemon",
    };
    const old = Object.fromEntries(
      Object.keys(changes).map((key) => [key, process.env[key]]),
    );
    for (const [key, value] of Object.entries(changes))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    t.after(() => {
      for (const [key, value] of Object.entries(old))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
    const root = path.resolve(__dirname, "../..");
    const load = createRequire(path.join(root, "package.json"));
    const modulePath = path.join(root, "src/queue-autostart.js");
    const autostart: Pick<
      typeof import("../src/entrypoints/queue-autostart"),
      "ensureBroker"
    > = load(modulePath);
    const connection: { queueDirectory(): string } = load(
      path.join(root, "src/queue-connection.js"),
    );
    assert.ok(
      connection.queueDirectory().startsWith(f.root + path.sep),
      "Only the owned fixture queue may be used",
    );
    const captured = path.join(f.root, "daemon-environment.json");
    const originalSpawn = childProcess.spawn;
    let starts = 0;
    let closed: Promise<unknown> | undefined;
    t.mock.method(
      childProcess,
      "spawn",
      (executable: string, args: readonly string[], options: SpawnOptions) => {
        assert.equal(executable, process.execPath);
        const nonce = args[1];
        assert.ok(nonce && /^[a-f0-9-]{36}$/.test(nonce));
        starts++;
        const child = originalSpawn(
          process.execPath,
          [
            "-e",
            `
      const fs=require("node:fs");
      const autostart=require(process.argv[1]);
      fs.writeFileSync(process.argv[3], JSON.stringify({
        profile:process.env.FMCAD_PHYSICAL_OPERATOR_PROFILE ?? null,
        unrelatedSecret:process.env.FMCAD_PROFILE_TEST_SECRET ?? null
      }), {mode:0o600,flag:"wx"});
      autostart.startupResult(process.cwd(),process.argv[2],
        {state:"failed",code:"OFFLINE_ENV_CAPTURED",message:"Owned environment-only fixture"});
      autostart.releaseStart(process.cwd(),process.argv[2]);
    `,
            modulePath,
            nonce,
            captured,
          ],
          options,
        );
        closed = new Promise((resolve) => child.once("close", resolve));
        t.after(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        });
        return child;
      },
    );
    const cfg: FmcadConfiguration = {
      ...DEFAULT_ADDIN_SETTINGS,
      backend: "addin",
      routing: "queue",
      url: "http://127.0.0.1:1/mcp",
      queue: { autoStart: true, autoRecover: false, startupTimeoutMs: 10000 },
      controlCenter: { port: 4748 },
    };
    await assert.rejects(
      autostart.ensureBroker(cfg, {
        clientId: "environment-fixture",
        clientToken: "offline-logical-client-token",
      }),
      (error: unknown) =>
        error instanceof Error &&
        Reflect.get(error, "code") === "OFFLINE_ENV_CAPTURED",
    );
    await closed;
    assert.equal(starts, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(captured, "utf8")), {
      profile: f.file,
      unrelatedSecret: null,
    });
  },
);

test(
  "private FIFO profile is rejected without blocking or constructing an issuer",
  linux,
  (t) => {
    const f = fixture(t);
    fs.unlinkSync(f.file);
    const fifo = childProcess.spawnSync("mkfifo", ["-m", "600", f.file], {
      encoding: "utf8",
    });
    assert.equal(fifo.status, 0, fifo.stderr);
    const result = childProcess.spawnSync(
      process.execPath,
      [
        "-e",
        `
    const {physicalBrokerPortsFromEnvironment}=require(process.argv[1]);
    let calls=0;
    try {
      physicalBrokerPortsFromEnvironment({FMCAD_PHYSICAL_OPERATOR_PROFILE:process.argv[2]},
        {provisionFactory(){calls++;throw Error("No issuer for a FIFO");}});
      console.log(JSON.stringify({code:"accepted",calls}));
    } catch(error) { console.log(JSON.stringify({code:error.code,calls})); }
  `,
        require.resolve("../packages/node-adapters/src/execution/physical-generation-profile"),
        f.file,
      ],
      { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" },
    );
    assert.equal(
      result.error,
      undefined,
      "Profile reader must not block on a FIFO",
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      code: "PHYSICAL_OPERATOR_PROFILE_REJECTED",
      calls: 0,
    });
  },
);

for (const transport of ["node", "windows-curl"] as const) {
  test(
    `private ${transport} profile composes deferred ports and preserves the control route`,
    linux,
    async (t) => {
      const f = fixture(t);
      f.profile.transport = transport;
      f.publish();
      let provisions = 0;
      let ownerValid = true;
      const token = "offline-profile-fixture-token-".repeat(3);
      const ports = physicalBrokerPortsFromEnvironment(
        { FMCAD_PHYSICAL_OPERATOR_PROFILE: f.file },
        {
          provisionFactory(options) {
            assert.deepEqual(options, f.profile.nativeProvision);
            return {
              async provision(descriptor: PhysicalGenerationDescriptor) {
                provisions++;
                assert.deepEqual(descriptor.brokerOwner, {
                  pid: process.pid,
                  birth: "actual-claim-birth",
                  nonce: "actual-claim-nonce",
                  clientId: f.profile.clientId,
                  queueDirectory: f.root,
                });
                const grantFile = path.join(f.root, "issued.json");
                const bytes = Buffer.from(
                  JSON.stringify({ ...descriptor, token }),
                );
                fs.writeFileSync(grantFile, bytes, { mode: 0o600, flag: "wx" });
                return {
                  grantFile,
                  grantDigest: createHash("sha256").update(bytes).digest("hex"),
                };
              },
            };
          },
        },
      );
      assert.ok(ports);
      assert.equal(provisions, 0);
      assert.throws(() =>
        ports.authorizePhysicalRequest(f.profile.runtime.endpointURL),
      );
      await ports.preparePhysicalGeneration({
        directory: f.root,
        owner: {
          pid: process.pid,
          birth: "actual-claim-birth",
          nonce: "actual-claim-nonce",
        },
        buildHash: "c".repeat(64),
        configHash: "d".repeat(64),
        assertBrokerOwner() {
          assert.ok(ownerValid);
        },
      });
      assert.equal(provisions, 1);
      assert.equal(
        ports.authorizePhysicalRequest(f.profile.runtime.endpointURL)[
          "X-Fmcad-Physical-Grant"
        ],
        token,
      );
      const binding = ports.bindPhysicalTurn({
        physicalRequestId: "control-read",
        documentSelector: { creationId: "target" },
      });
      const body = JSON.stringify({ state: "unknown", binding });
      let nodeQueries = 0;
      let curlQueries = 0;
      t.mock.method(globalThis, "fetch", async () => {
        nodeQueries++;
        return Response.json({ state: "unknown", binding });
      });
      const originalSpawn = childProcess.spawn;
      t.mock.method(
        childProcess,
        "spawn",
        (
          executable: string,
          _args: readonly string[],
          options: SpawnOptions,
        ) => {
          assert.equal(executable, "/mnt/c/Windows/System32/curl.exe");
          curlQueries++;
          const response = Buffer.from(
            `HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
          ).toString("base64");
          return originalSpawn(
            process.execPath,
            [
              "-e",
              `process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(Buffer.from("${response}","base64")));`,
            ],
            options,
          );
        },
      );
      assert.equal(
        (await ports.physicalTurnQuiescence(binding)).state,
        "unknown",
      );
      assert.equal(nodeQueries, transport === "node" ? 1 : 0);
      assert.equal(curlQueries, transport === "windows-curl" ? 1 : 0);
      ownerValid = false;
      assert.throws(() =>
        ports.authorizePhysicalRequest(f.profile.runtime.endpointURL),
      );
    },
  );
}

for (const invalid of [
  "file-public",
  "parent-public",
  "symlink",
  "parent-symlink",
  "hardlink",
  "utf8",
  "duplicate-key",
  "public-token",
  "forged-owner",
  "unknown-native-option",
  "bad-version",
  "bad-pid",
  "bad-hash",
  "bad-transport",
] as const) {
  test(
    `operator profile refuses ${invalid} before constructing an issuer`,
    linux,
    (t) => {
      const f = fixture(t);
      let file = f.file;
      if (invalid === "file-public") fs.chmodSync(file, 0o644);
      if (invalid === "parent-public") fs.chmodSync(f.root, 0o755);
      if (invalid === "symlink") {
        file = path.join(f.root, "alias.json");
        fs.symlinkSync(f.file, file);
      }
      if (invalid === "parent-symlink") {
        const alias = f.root + "-alias";
        fs.symlinkSync(f.root, alias);
        t.after(() => fs.unlinkSync(alias));
        file = path.join(alias, "operator.json");
      }
      if (invalid === "hardlink")
        fs.linkSync(file, path.join(f.root, "linked.json"));
      if (invalid === "utf8") fs.writeFileSync(file, Buffer.from([0xff]));
      if (invalid === "duplicate-key")
        fs.writeFileSync(file, '{"version":1,"version":1}');
      if (invalid === "public-token") {
        Reflect.set(f.profile, "token", "private-secret-marker");
        f.publish();
      }
      if (invalid === "forged-owner") {
        Reflect.set(f.profile.runtime, "brokerOwner", { nonce: "forged" });
        f.publish();
      }
      if (invalid === "unknown-native-option") {
        Reflect.set(f.profile.nativeProvision, "shell", true);
        f.publish();
      }
      if (invalid === "bad-version") {
        f.profile.version = 2;
        f.publish();
      }
      if (invalid === "bad-pid") {
        Reflect.set(f.profile.runtime.physicalRuntime, "pid", "42");
        f.publish();
      }
      if (invalid === "bad-hash") {
        f.profile.nativeProvision.installedPackageFiles["addon_runtime.py"] =
          "invalid";
        f.publish();
      }
      if (invalid === "bad-transport") {
        f.profile.transport = "direct";
        f.publish();
      }
      let factories = 0;
      assert.throws(
        () =>
          physicalBrokerPortsFromEnvironment(
            { FMCAD_PHYSICAL_OPERATOR_PROFILE: file },
            {
              provisionFactory() {
                factories++;
                assert.fail("No issuer construction for invalid profile");
              },
            },
          ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message.includes("private-secret-marker"), false);
          assert.equal("cause" in error, false);
          return (
            Reflect.get(error, "code") === "PHYSICAL_OPERATOR_PROFILE_REJECTED"
          );
        },
      );
      assert.equal(factories, 0);
    },
  );
}
