import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import type { ControlledFusionBootstrapPorts } from "../src/controlled-fusion-bootstrap";
import {
  createControlledFusionNativeHandoff,
  type ControlledNativeHandoffOptions,
} from "../packages/node-adapters/src/execution/controlled-native-handoff";
import { bootstrapInstalledFilesDigest } from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";
import { controlledNativeHandoffProgram } from "../packages/node-adapters/src/execution/controlled-native-handoff-program";

function pins(): ControlledNativeHandoffOptions {
  const files = Object.fromEntries(
    [
      "AutodeskFusionMCP.py",
      "addon_runtime.py",
      "lib/bootstrap_entry.py",
      ...Array.from({ length: 97 }, (_, i) => `fixture-${i}.txt`),
    ].map((name) => [name, "a".repeat(64)]),
  );
  const paths = Object.fromEntries(
    [
      "stage",
      "backup",
      "installClosure",
      "installReceipt",
      "provision",
      "provisionBackup",
      "rebindReceipt",
      "database",
      "launchJournal",
      "launchAttempt",
    ].map((name) => [name, `C:\\owned\\private\\${name}`]),
  ) as unknown as ControlledNativeHandoffOptions["paths"];
  return {
    nativePython: "C:\\vendor\\python.exe",
    mappedNativePython: "/owned/vendor/python.exe",
    nativePythonSha256: "b".repeat(64),
    helperDirectory: "C:\\owned\\qualified",
    mappedHelperDirectory: "/owned/qualified",
    mappedInstalledDirectory: "/owned/discovery/fork",
    manifest: {
      nativePath: "C:\\owned\\manifest.json",
      mappedPath: "/owned/manifest.json",
      sha256: "c".repeat(64),
    },
    qualified: {
      directory: "C:\\owned\\discovery\\fork",
      source: "d".repeat(40),
      build: bootstrapInstalledFilesDigest(files),
      files,
    },
    allDiscoveryRoots: ["C:\\owned\\discovery", "C:\\owned\\other-discovery"],
    old: { pid: 123, birth: "100" },
    nextGeneration: { instance: "already-committed", epoch: "next" },
    expectedProvisionSha256: "e".repeat(64),
    executable: "C:\\vendor\\Fusion360.exe",
    executableSha256: "f".repeat(64),
    paths,
    mappedPaths: Object.fromEntries(
      [
        ...Object.values(paths),
        "C:\\owned\\manifest.json",
        "C:\\vendor\\Fusion360.exe",
      ].map((name) => [
        name,
        path.resolve("/owned/mapped", path.win32.basename(name)),
      ]),
    ),
    heldLease: {
      async assertCurrent() {
        /* owned offline fixture, not real authority */
      },
      fence() {
        /* owned offline fixture */
      },
    },
  };
}

test("private factory denies incomplete discovery, in-discovery backup/stage and nonqualified build/data", () => {
  const original = pins();
  assert.ok(createControlledFusionNativeHandoff(original));
  for (const changed of [
    { ...original, allDiscoveryRoots: [] },
    {
      ...original,
      paths: {
        ...original.paths,
        backup: "C:\\owned\\other-discovery\\backup",
      },
    },
    {
      ...original,
      paths: { ...original.paths, stage: "C:\\owned\\discovery\\stage" },
    },
    {
      ...original,
      qualified: { ...original.qualified, build: "0".repeat(64) },
    },
    { ...original, qualified: { ...original.qualified, files: {} } },
    {
      ...original,
      paths: { ...original.paths, backup: "D:\\outside\\backup" },
    },
  ])
    assert.throws(() => createControlledFusionNativeHandoff(changed));
});

test("foreign/deserialized rebind records are never original private witnesses", async () => {
  const factory = createControlledFusionNativeHandoff(pins());
  let calls = 0;
  const forged = {
    process: { pid: 1, birth: "2" },
    reference: {
      nativePath: "C:\\forged",
      bytes: new Uint8Array(),
      sha256: "a".repeat(64),
      identity: "forged",
    },
    async assertCurrent() {
      calls++;
    },
    fence() {
      calls++;
    },
  };
  await assert.rejects(
    factory.assertOriginalRebindWitness(forged),
    /Original private/,
  );
  assert.equal(calls, 0);
});

test("synchronous lease mismatch is refused before native process start and attempt cannot replay", async () => {
  const options = pins();
  const factory = createControlledFusionNativeHandoff({
    ...options,
    heldLease: {
      async assertCurrent() {},
      async fence() {
        await Promise.resolve();
      },
    },
  });
  const input = { old: options.old, qualifiedPackagePins: options.qualified };
  await assert.rejects(
    factory.qualifyNativeInstallationAfterDeath(input),
    /synchronous/,
  );
  await assert.rejects(
    factory.qualifyNativeInstallationAfterDeath(input),
    /replayed/,
  );
});

test("native program parses as Python without executing imports, source installation or provision edits", () => {
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      "import ast,sys; ast.parse(sys.stdin.read(),filename='<controlled-native-handoff>')",
    ],
    {
      input: controlledNativeHandoffProgram,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("rejecting async lease is denied once without native effects or unhandled rejection in an actual strict Node subprocess", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "native-handoff-deny-"),
  );
  const result = spawnSync(
    process.execPath,
    [
      "--unhandled-rejections=strict",
      "-e",
      `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const childProcess = require("node:child_process");
    let spawns = 0, unhandled = 0;
    childProcess.spawn = () => { spawns++; throw Error("NATIVE_EFFECT_FORBIDDEN"); };
    process.on("unhandledRejection", () => { unhandled++; });
    const { createControlledFusionNativeHandoff } = require(${JSON.stringify(path.resolve("src/dist/node-adapters/execution/controlled-native-handoff.js"))});
    const pins = ${JSON.stringify(pins())};
    pins.heldLease = { async assertCurrent() {}, async fence() { throw Error("REJECTED_LEASE_FIXTURE"); } };
    const factory = createControlledFusionNativeHandoff(pins);
    (async () => {
      const input = { old: pins.old, qualifiedPackagePins: pins.qualified };
      await assert.rejects(factory.qualifyNativeInstallationAfterDeath(input), /synchronous/);
      await assert.rejects(factory.qualifyNativeInstallationAfterDeath(input), /replayed/);
      setImmediate(() => {
        assert.equal(spawns, 0);
        assert.equal(unhandled, 0);
        assert.deepEqual(fs.readdirSync(${JSON.stringify(directory)}), []);
        console.log("DENIED_NO_EFFECT_NO_REPLAY_SURVIVED");
      });
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /DENIED_NO_EFFECT_NO_REPLAY_SURVIVED/);
  assert.equal(result.stderr, "");
});

test("compiled controller synchronous guard rejects async lease/rebind callbacks without crashing a strict Node subprocess", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--unhandled-rejections=strict",
      "-e",
      `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const vm = require("node:vm");
    const source = fs.readFileSync("dist/src/controlled-fusion-bootstrap.js", "utf8");
    const start = source.indexOf("function synchronous(");
    const end = source.indexOf("function frozenFile(", start);
    assert.ok(start >= 0 && end > start);
    const guard = vm.runInThisContext(source.slice(start, end) + "; synchronous");
    let effects = 0, unhandled = 0;
    process.on("unhandledRejection", () => { unhandled++; });
    for (const name of ["lease", "rebind"]) {
      assert.throws(() => { guard(async () => { throw Error("REJECTED_" + name); }); effects++; }, /Synchronous/);
    }
    setImmediate(() => {
      assert.equal(effects, 0);
      assert.equal(unhandled, 0);
      console.log("CONTROLLER_DENIED_BOTH_SURVIVED");
    });
  `,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /CONTROLLER_DENIED_BOTH_SURVIVED/);
  assert.equal(result.stderr, "");
});

test("normal staged helper loads without workspace packages and structurally supplies the APP671 concrete ports", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "native-handoff-staged-"),
  );
  const execution = path.join(directory, "execution");
  fs.mkdirSync(execution);
  for (const name of [
    "controlled-native-handoff",
    "controlled-native-handoff-program",
    "controlled-fusion-launch",
    "controlled-fusion-launch-native",
    "bootstrap-entry-evidence",
    "fusion-bootstrap-autoload",
    "admission-json",
  ])
    fs.copyFileSync(
      path.resolve(`src/dist/node-adapters/execution/${name}.js`),
      path.join(execution, `${name}.js`),
    );
  const staged = createRequire(path.join(directory, "entry.cjs"))(
    "./execution/controlled-native-handoff.js",
  ) as typeof import("../packages/node-adapters/src/execution/controlled-native-handoff");
  const factory = staged.createControlledFusionNativeHandoff(pins());
  const ports: Pick<
    ControlledFusionBootstrapPorts,
    "qualifyNativeInstallationAfterDeath" | "rebindNative"
  > = factory;
  assert.equal(ports.rebindNative, factory.rebindNative);
  assert.equal(fs.existsSync(path.join(directory, "packages")), false);
});
