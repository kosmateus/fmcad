import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { discoverNormalNativeRuntime, mapWindowsRuntimePath } from "../packages/node-adapters/src/execution/normal-native-runtime";
import { physicalBrokerPortsFromEnvironment } from "../packages/node-adapters/src/execution/physical-generation-profile";
import { PhysicalGenerationProvisionError } from "../packages/node-adapters/src/execution/physical-generation-provision";
import { DEFAULT_ADDIN_SETTINGS } from "../packages/core/src/domain/config";

test("public broker composition discovers the default addin backend before any SDK startup", async t => {
  const f = fixture(t);
  const load = createRequire(path.resolve(__dirname, "../../src/queue-broker.js"));
  const module = load.resolve("./dist/node-adapters/execution/normal-native-runtime");
  load(module);
  const original = load.cache[module]!.exports;
  const profile = process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"];
  delete process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"];
  t.after(() => {
    load.cache[module]!.exports = original;
    if (profile !== undefined) process.env["FMCAD_PHYSICAL_OPERATOR_PROFILE"] = profile;
  });
  load.cache[module]!.exports = {
    async discoverNormalNativeRuntime(directory: string) {
      assert.equal(directory, f.root);
      throw new Error("DEFAULT_NATIVE_DISCOVERY_REACHED");
    },
  };
  const broker = load(path.resolve(__dirname, "../../src/queue-broker.js")) as typeof import("../src/composition/queue-broker");
  // No ownership confirmation: even a regression cannot proceed to the SDK.
  await assert.rejects(broker.serve(DEFAULT_ADDIN_SETTINGS, { dir: f.root }), /DEFAULT_NATIVE_DISCOVERY_REACHED/);
  assert.equal(fs.existsSync(path.join(f.root, "broker.lock")), false);
});

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "normal-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, "installed");
  fs.mkdirSync(path.join(installed, "lib"), { recursive: true });
  for (const name of ["normal_runtime.py", "physical_authority.py", "physical_lifecycle.py"])
    fs.writeFileSync(path.join(installed, "lib", name), "# owned fixture\n");
  const python = path.join(root, "python.exe");
  fs.writeFileSync(python, "owned fake interpreter");
  const config = {
    kind: "fmcad-normal-native-runtime", version: 1,
    installedForkDirectory: "C:\\AddIns\\AutodeskFusionMCP",
    provisionPath: "C:\\Local\\AutodeskFusionMCP\\physical\\normal-provisions\\instance.json",
    nativePrivateDirectory: "C:\\Local\\AutodeskFusionMCP\\clients",
    descriptor: {
      handoffId: "normal-start-instance-epoch",
      generation: { instance: "instance", epoch: "epoch" },
      endpointURL: "http://127.0.0.1:8765/mcp",
      physicalRuntime: { pid: 42, birth: "birth", source: "source", build: "build", version: "native" },
    },
  };
  const metadata = {
    config, nativePython: "C:\\Fusion\\Python\\python.exe", localAppData: "C:\\Local",
    installedForkDirectory: config.installedForkDirectory,
  };
  const mapPath = (value: string) => value === metadata.installedForkDirectory
    ? installed : value === metadata.nativePython ? python : path.join(root, "clients");
  return { root, installed, python, config, metadata, mapPath };
}

function nextRuntimeConfig(current: ReturnType<typeof fixture>) {
  const next = structuredClone(current.config);
  next.provisionPath = "C:\\Local\\AutodeskFusionMCP\\physical\\normal-provisions\\instance-2.json";
  next.descriptor = {
    ...next.descriptor,
    handoffId: "normal-start-instance-2-epoch-2",
    generation: { instance: "instance-2", epoch: "epoch-2" },
    physicalRuntime: { ...next.descriptor.physicalRuntime, pid: 43, birth: "birth-2" },
  };
  return next;
}

function startingMetadata(config: unknown, starting: unknown, installedForkDirectory: string) {
  return JSON.stringify({ state: "starting", config, starting, localAppData: "C:\\Local", installedForkDirectory });
}

test("ordinary discovery waits only for a journal-bound normal startup before native verification", async t => {
  const f = fixture(t);
  const next = nextRuntimeConfig(f);
  const startup = { config: next, previous: f.config };
  const calls: string[] = [];
  let metadataReads = 0;
  const dependencies = {
    environment: { WSL_DISTRO_NAME: "owned-fixture" },
    mapPath: f.mapPath,
    startupTimeoutMs: 1000,
    async run(file: string, args: string[], _input: string, _env: NodeJS.ProcessEnv, cwd?: string) {
      calls.push(file === f.python ? "native" : "metadata");
      if (file === f.python) {
        assert.equal(metadataReads, 2, "native verification starts only after ready metadata");
        assert.equal(cwd, f.installed);
        return JSON.stringify(next);
      }
      assert.deepEqual(args.slice(0, 2), ["-NoProfile", "-NonInteractive"]);
      assert.equal(args[2], "-Command");
      assert.match(args[3] ?? "", /normal-starting\.json/);
      assert.match(args[3] ?? "", /NoProcessFoundForGivenId/);
      if (++metadataReads === 1)
        return startingMetadata(f.config, startup, f.config.installedForkDirectory);
      return JSON.stringify({ ...f.metadata, config: next });
    },
  };
  const profile = await discoverNormalNativeRuntime(f.root, dependencies);
  assert.ok(profile);
  assert.deepEqual(calls, ["metadata", "metadata", "native"]);
  assert.equal(profile.runtime.physicalRuntime.pid, 43);
});

test("ordinary discovery refuses an unbound, malformed or foreign startup journal without retry", async t => {
  const f = fixture(t);
  const next = nextRuntimeConfig(f);
  const sameGeneration = structuredClone(f.config);
  sameGeneration.descriptor.endpointURL = "http://127.0.0.1:8766/mcp";
  const cases = [
    { config: next, previous: { ...f.config, provisionPath: "C:\\Foreign\\old.json" } },
    { config: next, previous: null },
    { config: { ...next, version: 2 }, previous: f.config },
    { config: { ...next, installedForkDirectory: "D:\\Foreign\\AddIns\\AutodeskFusionMCP" }, previous: f.config },
    { config: sameGeneration, previous: f.config },
    { config: next, previous: f.config, extra: true },
  ];
  for (const startup of cases) {
    let calls = 0;
    await assert.rejects(discoverNormalNativeRuntime(f.root, {
      environment: { WSL_DISTRO_NAME: "owned-fixture" },
      mapPath: f.mapPath,
      async run() {
        calls++;
        return startingMetadata(f.config, startup, f.config.installedForkDirectory);
      },
    }), { code: "NATIVE_RUNTIME_DISCOVERY_REJECTED" });
    assert.equal(calls, 1);
  }
});

test("ordinary discovery rejects a changed config after confirming startup", async t => {
  const f = fixture(t);
  const startup = { config: nextRuntimeConfig(f), previous: f.config };
  let calls = 0;
  await assert.rejects(discoverNormalNativeRuntime(f.root, {
    environment: { WSL_DISTRO_NAME: "owned-fixture" },
    mapPath: f.mapPath,
    async run() {
      calls++;
      return calls === 1
        ? startingMetadata(f.config, startup, f.config.installedForkDirectory)
        : JSON.stringify(f.metadata);
    },
  }), { code: "NATIVE_RUNTIME_DISCOVERY_REJECTED" });
  assert.equal(calls, 2);
});

test("ordinary discovery bounds retries for a journal-confirmed startup", async t => {
  const f = fixture(t);
  const startup = { config: nextRuntimeConfig(f), previous: f.config };
  let calls = 0;
  const dependencies = {
    environment: { WSL_DISTRO_NAME: "owned-fixture" },
    startupTimeoutMs: 250,
    async run() {
      calls++;
      return startingMetadata(f.config, startup, f.config.installedForkDirectory);
    },
  };
  await assert.rejects(discoverNormalNativeRuntime(f.root, dependencies), {
    code: "NATIVE_RUNTIME_DISCOVERY_REJECTED",
  });
  assert.ok(calls > 1);
  assert.ok(calls < 5, `expected bounded metadata retries, got ${calls}`);
});

test("ordinary discovery rejects ready metadata returned after the remaining startup budget", async t => {
  const f = fixture(t);
  const next = nextRuntimeConfig(f);
  const startup = { config: next, previous: f.config };
  let calls = 0;
  let readTimeoutMs: number | undefined;
  let nativeReads = 0;
  await assert.rejects(discoverNormalNativeRuntime(f.root, {
    environment: { WSL_DISTRO_NAME: "owned-fixture" },
    mapPath: f.mapPath,
    startupTimeoutMs: 250,
    async run(file, _args, _input, _env, _cwd, timeoutMs?: number) {
      calls++;
      if (file === f.python) {
        nativeReads++;
        return JSON.stringify(next);
      }
      if (calls === 1)
        return startingMetadata(f.config, startup, f.config.installedForkDirectory);
      readTimeoutMs = timeoutMs;
      await new Promise(resolve => setTimeout(resolve, 300));
      return JSON.stringify({ ...f.metadata, config: next });
    },
  }), { code: "NATIVE_RUNTIME_DISCOVERY_REJECTED" });
  assert.equal(calls, 2);
  assert.equal(nativeReads, 0);
  assert.ok(readTimeoutMs !== undefined && readTimeoutMs > 0 && readTimeoutMs < 250);
});

test("ordinary discovery does not retry an absent process without its startup journal", async t => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(discoverNormalNativeRuntime(f.root, {
    environment: { WSL_DISTRO_NAME: "owned-fixture" },
    async run() {
      calls++;
      throw new Error("Native discovery process failed");
    },
  }), /Native discovery process failed/);
  assert.equal(calls, 1);
});

test("ordinary discovery composes a deferred claimed grant without profile environment or SDK execution", async t => {
  const f = fixture(t);
  let discoveries = 0;
  const profile = await discoverNormalNativeRuntime(f.root, {
    environment: { WSL_DISTRO_NAME: "owned-fixture" }, mapPath: f.mapPath,
    async run(file, args, input, env, cwd) {
      if (++discoveries === 1) return JSON.stringify(f.metadata);
      assert.equal(file, f.python);
      assert.deepEqual(args.slice(0, 3), ["-I", "-S", "-B"]);
      assert.equal(cwd, f.installed);
      assert.equal(env["WSL_DISTRO_NAME"], "owned-fixture");
      const pins = JSON.parse(input).pins;
      assert.ok(pins.installedPackageFiles["lib/normal_runtime.py"]);
      assert.equal(pins.linuxGrantDirectory, f.root);
      return JSON.stringify(f.config);
    },
  });
  assert.ok(profile);
  assert.equal(discoveries, 2);
  let issued = 0, owners = 0;
  const ports = physicalBrokerPortsFromEnvironment({}, {
    normalRuntime: profile,
    provisionFactory() {
      return { async provision(descriptor) {
        issued++;
        assert.equal(descriptor.brokerOwner.nonce, "actual-owner");
        throw new PhysicalGenerationProvisionError("notStarted");
      } };
    },
  });
  assert.ok(ports);
  assert.equal(issued, 0, "discovery is not grant issuance");
  await assert.rejects(ports.preparePhysicalGeneration({
    directory: f.root,
    owner: { pid: process.pid, birth: "broker-birth", nonce: "actual-owner" },
    buildHash: "a".repeat(64), configHash: "b".repeat(64),
    assertBrokerOwner() { owners++; },
  }), { code: "PHYSICAL_GENERATION_REJECTED", notStarted: true });
  assert.equal(issued, 1);
  assert.ok(owners > 0);
});

test("discovery refuses a changed native projection and foreign namespace", async t => {
  const f = fixture(t);
  for (const mode of ["changed", "foreign", "protected-output"]) {
    let calls = 0;
    const metadata = structuredClone(f.metadata);
    if (mode === "foreign") metadata.config.provisionPath = "C:\\Foreign\\provision.json";
    if (mode === "protected-output")
      metadata.config.nativePrivateDirectory = "C:\\Local\\AutodeskFusionMCP\\physical\\clients";
    await assert.rejects(discoverNormalNativeRuntime(f.root, {
      environment: { WSL_DISTRO_NAME: "fixture" }, mapPath: f.mapPath,
      async run() {
        calls++;
        return JSON.stringify(calls === 1 ? metadata : { ...f.config, version: 2 });
      },
    }), { code: "NATIVE_RUNTIME_DISCOVERY_REJECTED" });
    assert.equal(calls, mode === "changed" ? 2 : 1);
  }
});

test("missing normal runtime does not create a store or invoke an issuer", async () => {
  let calls = 0;
  assert.equal(await discoverNormalNativeRuntime("/unused", {
    environment: { WSL_DISTRO_NAME: "fixture" },
    async run() { calls++; return "null"; },
  }), undefined);
  assert.equal(calls, 1);
  assert.equal(await discoverNormalNativeRuntime("/unused", {
    environment: {}, async run() { assert.fail("No Windows discovery outside WSL"); },
  }), undefined);
});

test("normal discovery cannot substitute for consumed-root authority", async t => {
  const f = fixture(t);
  const profile = await discoverNormalNativeRuntime(f.root, {
    environment: { WSL_DISTRO_NAME: "fixture" }, mapPath: f.mapPath,
    async run(file) { return JSON.stringify(file === f.python ? f.config : f.metadata); },
  });
  assert.ok(profile);
  const ports = physicalBrokerPortsFromEnvironment({}, {
    normalRuntime: profile,
    provisionFactory() { return { async provision() { assert.fail("No grant without root authority"); } }; },
  });
  assert.ok(ports);
  fs.writeFileSync(path.join(f.root, "runtime-rebaseline-head.json"), "{}");
  await assert.rejects(ports.preparePhysicalGeneration({
    directory: f.root, owner: { pid: 1, birth: "birth", nonce: "nonce" },
    buildHash: "a".repeat(64), configHash: "b".repeat(64), assertBrokerOwner() {},
  }), { code: "RUNTIME_ROOT_CONTROLLER_REQUIRED" });
});

test("Windows path mapping refuses UNC and noncanonical traversal", () => {
  assert.equal(mapWindowsRuntimePath("C:\\Users\\name\\Python\\python.exe"),
    "/mnt/c/Users/name/Python/python.exe");
  for (const value of ["\\\\server\\share", "C:\\a\\..\\b", "relative", "C:/absolute"])
    assert.throws(() => mapWindowsRuntimePath(value), { code: "NATIVE_RUNTIME_DISCOVERY_REJECTED" });
});
