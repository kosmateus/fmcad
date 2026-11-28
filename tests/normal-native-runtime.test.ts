import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverNormalNativeRuntime, mapWindowsRuntimePath } from "../packages/node-adapters/src/execution/normal-native-runtime";
import { physicalBrokerPortsFromEnvironment } from "../packages/node-adapters/src/execution/physical-generation-profile";
import { PhysicalGenerationProvisionError } from "../packages/node-adapters/src/execution/physical-generation-provision";

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
    provisionPath: "C:\\Local\\fmcad\\addin-admission\\normal-provisions\\current.json",
    nativePrivateDirectory: "C:\\Local\\fmcad\\addin-admission\\clients",
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
  for (const mode of ["changed", "foreign"]) {
    let calls = 0;
    const metadata = structuredClone(f.metadata);
    if (mode === "foreign") metadata.config.provisionPath = "C:\\Foreign\\provision.json";
    await assert.rejects(discoverNormalNativeRuntime(f.root, {
      environment: { WSL_DISTRO_NAME: "fixture" }, mapPath: f.mapPath,
      async run() {
        calls++;
        return JSON.stringify(calls === 1 ? metadata : { ...f.config, version: 2 });
      },
    }), { code: "NATIVE_RUNTIME_DISCOVERY_REJECTED" });
    assert.equal(calls, mode === "foreign" ? 1 : 2);
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
