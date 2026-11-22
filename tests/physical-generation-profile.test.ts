import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import childProcess, { type SpawnOptions } from "node:child_process";
import test from "node:test";
import { physicalBrokerPortsFromEnvironment } from "../packages/node-adapters/src/execution/physical-generation-profile";
import type { PhysicalGenerationDescriptor } from "../packages/node-adapters/src/execution/physical-generation";

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
