import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import type { ControlledFusionBootstrapPorts } from "../src/controlled-fusion-bootstrap";
import type { OwnedFusionBootstrapPorts } from "../src/owned-fusion-bootstrap";
import {
  createControlledFusionNativeHandoff,
  type ControlledNativeHandoffOptions,
  createOwnedNativeReboundObserver,
  type OwnedNativeReboundOptions,
} from "../packages/node-adapters/src/execution/controlled-native-handoff";
import { bootstrapInstalledFilesDigest } from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";
import {
  controlledNativeHandoffProgram,
  ownedNativeReboundProgram,
} from "../packages/node-adapters/src/execution/controlled-native-handoff-program";

function ownedPins(): OwnedNativeReboundOptions {
  const base = pins();
  const file = (nativePath: string) => {
    const bytes = Buffer.from("{}");
    return {
      nativePath,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      identity: "[1,2,3,4,5,6,7,8,9,1,0]",
    };
  };
  const owned = {
    database: {
      nativePath: base.paths.database,
      identity: "[1,2,3,4,5,6,7,8,9,1,0]",
    },
    handoffRequest: file("C:\\owned\\private\\handoff.json"),
    handoffReceipt: file("C:\\owned\\private\\completed.json"),
    installReceipt: file(base.paths.installReceipt),
    installClosure: file(base.paths.installClosure),
    entry: file("C:\\owned\\private\\entry.json"),
    returned: file("C:\\owned\\private\\returned.json"),
    auditPath: "C:\\owned\\private\\owned-observation.json",
  };
  const names = [
    owned.handoffRequest.nativePath,
    owned.handoffReceipt.nativePath,
    owned.entry.nativePath,
    owned.returned.nativePath,
    owned.auditPath,
  ];
  return {
    ...base,
    owned,
    mappedPaths: {
      ...base.mappedPaths,
      ...Object.fromEntries(
        names.map((name, i) => [name, `/owned/static-${i}`]),
      ),
    },
  };
}
test("owned readonly port exposes no mutating operations and requires exact distinct original mappings", () => {
  assert.throws(
    () => createControlledFusionNativeHandoff(ownedPins()),
    /Separate owned readonly factory/,
  );
  assert.deepEqual(Object.keys(createOwnedNativeReboundObserver(ownedPins())), [
    "observeNativeRebound",
    "assertOriginalOwnedReboundWitness",
  ]);
  for (const change of [
    (p: OwnedNativeReboundOptions) =>
      Object.assign(p.owned, { auditPath: p.paths.provision }),
    (p: OwnedNativeReboundOptions) =>
      Object.assign(p.owned, {
        auditPath: p.qualified.directory + "\\audit.json",
      }),
    (p: OwnedNativeReboundOptions) =>
      Object.assign(p.owned.entry, { nativePath: p.owned.returned.nativePath }),
    (p: OwnedNativeReboundOptions) =>
      Object.assign(p.owned.installClosure, { sha256: "0".repeat(64) }),
  ]) {
    const p = ownedPins();
    change(p);
    assert.throws(() => createOwnedNativeReboundObserver(p));
  }
});
test("separate owned program compiles and foreign copied witness has no lifetime authority", async () => {
  const compiled = spawnSync(
    "python3",
    ["-I", "-B", "-c", "import ast,sys;ast.parse(sys.stdin.read())"],
    { input: ownedNativeReboundProgram(), encoding: "utf8" },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
  const port = createOwnedNativeReboundObserver(ownedPins());
  await assert.rejects(
    port.assertOriginalOwnedReboundWitness({
      process: { pid: 1, birth: "1" },
      reference: ownedPins().owned.entry,
      async assertCurrent() {},
      fence() {},
    }),
    /Original private owned rebound witness/,
  );
});

function pins(): ControlledNativeHandoffOptions {
  const files = Object.fromEntries(
    [
      "AutodeskFusionMCP.py",
      "addon_runtime.py",
      "lib/bootstrap_entry.py",
      "lib/startup_audit.py",
      "lib/physical_authority.py",
      "lib/rebaseline_fence.py",
      "lib/request_admission.py",
      "fusion_bridge/dispatch.py",
      "fusion_bridge/runtime.py",
      "fusion_bridge/admission_runtime.py",
      "fixture.txt",
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

test(
  "approved startup-audit package retains the complete source/build manifest",
  { skip: !process.env["FMCAD_CONTROLLED_WINDOWS_FIXTURE_PINS"] },
  () => {
    const fixture = JSON.parse(
      fs.readFileSync(
        process.env["FMCAD_CONTROLLED_WINDOWS_FIXTURE_PINS"]!,
        "utf8",
      ),
    ) as {
      mappedManifest: string;
      source: string;
      legacyMappedManifest: string;
    };
    const files = JSON.parse(
      fs.readFileSync(fixture.mappedManifest, "utf8"),
    ) as Record<string, string>;
    assert.equal(fixture.source, "8818d2c8dcbcc9988992da561f276ea9b6a0e241");
    assert.equal(Object.keys(files).length, 104);
    assert.equal(
      bootstrapInstalledFilesDigest(files),
      "38d188040c6ffc0b55fe9aeb5cc10521512ce85a13823b8ab96420976c8bae88",
    );
    const options = pins();
    assert.ok(
      createControlledFusionNativeHandoff({
        ...options,
        qualified: {
          ...options.qualified,
          files,
          source: fixture.source,
          build: bootstrapInstalledFilesDigest(files),
        },
      }),
    );
    const legacy = JSON.parse(
      fs.readFileSync(fixture.legacyMappedManifest, "utf8"),
    ) as Record<string, string>;
    assert.equal(Object.keys(legacy).length, 100);
    assert.equal(legacy["lib/startup_audit.py"], undefined);
    assert.throws(
      () =>
        createControlledFusionNativeHandoff({
          ...options,
          qualified: {
            ...options.qualified,
            files: legacy,
            source: "d52dbe4d3b4540b5fe3af72e762c4337a9f6589d",
            build: bootstrapInstalledFilesDigest(legacy),
          },
        }),
      /audited package/,
    );
  },
);

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

test("qualified file count follows original full-map pins, not a fixed package size", () => {
  const options = pins();
  for (const additions of [0, 2, 93]) {
    const files = {
      ...options.qualified.files,
      ...Object.fromEntries(
        Array.from({ length: additions }, (_, i) => [
          `resources/qualified-${i}.txt`,
          "a".repeat(64),
        ]),
      ),
    };
    assert.ok(
      createControlledFusionNativeHandoff({
        ...options,
        qualified: {
          ...options.qualified,
          files,
          build: bootstrapInstalledFilesDigest(files),
        },
      }),
    );
  }
});

test("unsafe Windows names, case aliases, missing audit/core and oversized maps refuse even with recomputed digest", () => {
  const options = pins();
  for (const name of [
    "../escape.py",
    "/absolute.py",
    "lib//other.py",
    "lib/./other.py",
    "lib/../other.py",
    "lib\\other.py",
    "C:other.py",
    "nul.txt",
    "lib/COM1.py",
    "trailing.",
    "trailing ",
    "lib/other?.py",
    "lib/\0.py",
    "LIB/other.py",
    "lib/STARTUP_AUDIT.py",
    "lib",
  ]) {
    const files = { ...options.qualified.files, [name]: "a".repeat(64) };
    assert.throws(
      () =>
        createControlledFusionNativeHandoff({
          ...options,
          qualified: {
            ...options.qualified,
            files,
            build: bootstrapInstalledFilesDigest(files),
          },
        }),
      /safe unique Windows names/,
      name,
    );
  }
  for (const name of Object.keys(options.qualified.files).filter(
    (name) => name !== "fixture.txt",
  )) {
    const files = { ...options.qualified.files };
    delete files[name];
    assert.throws(
      () =>
        createControlledFusionNativeHandoff({
          ...options,
          qualified: {
            ...options.qualified,
            files,
            build: bootstrapInstalledFilesDigest(files),
          },
        }),
      /audited package/,
      name,
    );
  }
  const files = Object.fromEntries(
    Array.from({ length: 4097 }, (_, i) => [`file-${i}`, "a".repeat(64)]),
  );
  assert.throws(() =>
    createControlledFusionNativeHandoff({
      ...options,
      qualified: {
        ...options.qualified,
        files,
        build: bootstrapInstalledFilesDigest(files),
      },
    }),
  );
});

test("caller JSON cannot replace original source/build/full map or truncate evolution after factory capture", async () => {
  for (const field of [
    "source",
    "build",
    "missing",
    "extra",
    "renamed",
    "changed",
  ]) {
    const options = pins();
    let leaseCalls = 0;
    const factory = createControlledFusionNativeHandoff({
      ...options,
      heldLease: {
        async assertCurrent() {
          leaseCalls++;
        },
        fence() {},
      },
    });
    const qualified = { ...options.qualified };
    const files = { ...qualified.files };
    if (field === "source") qualified.source = "0".repeat(40);
    if (field === "build") qualified.build = "0".repeat(64);
    if (field === "missing") delete files["fixture.txt"];
    if (field === "extra") files["extra.txt"] = "0".repeat(64);
    if (field === "renamed") {
      delete files["fixture.txt"];
      files["renamed.txt"] = "a".repeat(64);
    }
    if (field === "changed") files["fixture.txt"] = "0".repeat(64);
    await assert.rejects(
      factory.qualifyNativeInstallationAfterDeath({
        old: options.old,
        qualifiedPackagePins: { ...qualified, files },
      }),
      /original old tuple\/qualified package differs/,
    );
    assert.equal(leaseCalls, 0);
  }
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

test("fixed native program independently refuses unsafe package pins before platform/import/effects", () => {
  const qualified = pins().qualified;
  const missingAudit = { ...qualified.files };
  delete missingAudit["lib/startup_audit.py"];
  for (const changed of [
    { ...qualified, source: "not-a-source" },
    { ...qualified, build: "not-a-build" },
    { ...qualified, files: missingAudit },
    {
      ...qualified,
      files: { ...qualified.files, "LIB/other.py": "a".repeat(64) },
    },
    {
      ...qualified,
      files: { ...qualified.files, "lib/nul.txt": "a".repeat(64) },
    },
    { ...qualified, files: { ...qualified.files, lib: "a".repeat(64) } },
  ]) {
    const result = spawnSync(
      "python3",
      ["-I", "-S", "-B", "-c", controlledNativeHandoffProgram],
      {
        input: JSON.stringify({
          pins: { qualified: changed },
          action: "install",
          input: {},
        }),
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /qualified|Qualified/);
    assert.doesNotMatch(result.stderr, /Native Windows required|WinDLL|adsk/);
    assert.equal(result.stdout, "");
  }
});

const superscriptDevicePaths = [
  "COM¹",
  "COM²",
  "COM³",
  "LPT¹",
  "LPT²",
  "LPT³",
].flatMap((name) => [`lib/${name}`, `lib/${name}.py`, `lib/${name}/entry.py`]);

test("Windows superscript device names refuse in the TypeScript validator in every path position", () => {
  const options = pins();
  for (const name of superscriptDevicePaths) {
    const files = { ...options.qualified.files, [name]: "a".repeat(64) };
    assert.throws(
      () =>
        createControlledFusionNativeHandoff({
          ...options,
          qualified: {
            ...options.qualified,
            files,
            build: bootstrapInstalledFilesDigest(files),
          },
        }),
      /safe unique Windows names/,
      name,
    );
  }
});

test("exact native program refuses Windows superscript device names before platform or imports", () => {
  const options = pins();
  for (const name of superscriptDevicePaths) {
    const files = { ...options.qualified.files, [name]: "a".repeat(64) };
    const qualified = {
      ...options.qualified,
      files,
      build: bootstrapInstalledFilesDigest(files),
    };
    const result = spawnSync(
      "python3",
      ["-I", "-S", "-B", "-c", controlledNativeHandoffProgram],
      {
        input: JSON.stringify({
          pins: { qualified },
          action: "install",
          input: {},
        }),
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, /Unsafe qualified Windows name\/hash/, name);
    assert.doesNotMatch(
      result.stderr,
      /Native Windows required|WinDLL|adsk/,
      name,
    );
    assert.equal(result.stdout, "");
  }
});

test("ordinary Unicode UTF-8 paths remain accepted by both package validators", () => {
  const options = pins();
  for (const name of ["lib/zażółć.py", "資料/通常.py", "lib/serial-¹.py"]) {
    const files = { ...options.qualified.files, [name]: "a".repeat(64) };
    const qualified = {
      ...options.qualified,
      files,
      build: bootstrapInstalledFilesDigest(files),
    };
    assert.ok(createControlledFusionNativeHandoff({ ...options, qualified }));
    const result = spawnSync(
      "python3",
      ["-I", "-S", "-B", "-c", controlledNativeHandoffProgram],
      {
        input: JSON.stringify({
          pins: { qualified },
          action: "install",
          input: {},
        }),
        encoding: "utf8",
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Native Windows required/, name);
    assert.doesNotMatch(
      result.stderr,
      /Unsafe qualified|case alias|adsk/,
      name,
    );
  }
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
    "owned-autoload-launch-native",
    "normal-observer-launch-native",
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
  assert.deepEqual(
    Object.keys(staged.createOwnedNativeReboundObserver(ownedPins())),
    ["observeNativeRebound", "assertOriginalOwnedReboundWitness"],
  );
  const readonlyPorts: Pick<OwnedFusionBootstrapPorts, "observeNativeRebound"> =
    staged.createOwnedNativeReboundObserver(ownedPins());
  assert.equal(typeof readonlyPorts.observeNativeRebound, "function");
  const ports: Pick<
    ControlledFusionBootstrapPorts,
    "qualifyNativeInstallationAfterDeath" | "rebindNative"
  > = factory;
  assert.equal(ports.rebindNative, factory.rebindNative);
  assert.equal(fs.existsSync(path.join(directory, "packages")), false);
});
