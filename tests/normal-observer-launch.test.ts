import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  createNormalObserverLaunchAdapter,
  type NormalObserverLaunchPins,
  createOwnedAutoloadLaunchAdapter,
  type OwnedAutoloadLaunchPins,
} from "../packages/node-adapters/src/execution/controlled-fusion-launch";
import { bootstrapInstalledFilesDigest } from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";
import {
  controlledFusionLaunchNative,
  normalObserverFusionLaunchNative,
  normalObserverNativeBootstrap,
} from "../packages/node-adapters/src/execution/controlled-fusion-launch-native";
import { ownedAutoloadLaunchNative } from "../packages/node-adapters/src/execution/owned-autoload-launch-native";

function pins(): NormalObserverLaunchPins {
  const root = "C:\\fixture";
  const names = [
    "AutodeskFusionMCP.py",
    "addon_runtime.py",
    "lib/physical_authority.py",
    "lib/request_admission.py",
    "lib/rebaseline_fence.py",
  ];
  const files = Object.fromEntries(names.map((name) => [name, "a".repeat(64)]));
  const paths = {
    profile: `${root}\\profile.json`,
    profileBackup: `${root}\\profile-backup.json`,
    intent: `${root}\\UNUSED-intent.json`,
    receiptDirectory: `${root}\\receipts`,
    entry: `${root}\\receipts\\UNUSED-entry.json`,
    returned: `${root}\\receipts\\UNUSED-return.json`,
    launchAttempt: `${root}\\attempt.json`,
    launchJournal: `${root}\\journal.json`,
    sourceClosure: `${root}\\source.json`,
    transcript: `${root}\\transcript.json`,
    provision: `${root}\\provision.json`,
  };
  const normal = {
    database: {
      nativePath: `${root}\\database.sqlite3`,
      identity: "[1,2,3,4,5,6,7,8,9,1,0]",
    },
    provisionSha256: "b".repeat(64),
    handoffRequest: {
      nativePath: `${root}\\handoff.json`,
      sha256: "c".repeat(64),
    },
    handoffReceipt: {
      nativePath: `${root}\\completed.json`,
      sha256: "d".repeat(64),
    },
    provisionBackupPath: `${root}\\provision-before.json`,
    provisionReceiptPath: `${root}\\provision-bound.json`,
    retiredProcessPath: `${root}\\retired-process.json`,
    coldProcessPath: `${root}\\cold-process.json`,
    installedFiles: { ...files, "__pycache__/existing.pyc": "e".repeat(64) },
  };
  const originals = [
    normal.database.nativePath,
    normal.handoffRequest.nativePath,
    normal.handoffReceipt.nativePath,
    normal.provisionBackupPath,
    normal.provisionReceiptPath,
    normal.retiredProcessPath,
    normal.coldProcessPath,
  ];
  return {
    nativePython: `${root}\\python.exe`,
    mappedNativePython: "/not-a-native-executable",
    nativePythonSha256: "f".repeat(64),
    sourceDirectory: `${root}\\helper`,
    mappedSourceDirectory: "/not-a-helper",
    installedDirectory: `${root}\\installed`,
    mappedInstalledDirectory: "/not-installed",
    installedSource: "a".repeat(40),
    installedBuild:
      "ed336029c8960f4809b5bef7651db354db6cfdcc759dc6acba8e45e2bd967e35",
    installedFiles: files,
    executable: `${root}\\fusion.exe`,
    mappedExecutable: "/not-a-vendor-executable",
    executableSha256: "f".repeat(64),
    arguments: [],
    workingDirectory: root,
    paths,
    originalPaths: originals,
    mappedOriginalPaths: Object.fromEntries(
      [...Object.values(paths), ...originals].map((name, i) => [
        name,
        `/fixture/${i}`,
      ]),
    ),
    receiptTimeoutMs: 100,
    normalCloseTimeoutMs: 100,
    mainWindowClass: "fixture",
    normal,
    assertHeld() {},
  };
}

test("normal native program compiles as complete Python, including suspended binding path", () => {
  for (const source of [
    controlledFusionLaunchNative,
    normalObserverFusionLaunchNative(),
    normalObserverNativeBootstrap,
    ownedAutoloadLaunchNative(),
  ]) {
    const result = spawnSync(
      "python3",
      ["-I", "-B", "-c", "import ast,sys;ast.parse(sys.stdin.read())"],
      {
        input: source,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
  }
});

function ownedPins(): OwnedAutoloadLaunchPins {
  const { normal, ...base } = pins();
  const originals = ["one.xml", "two.xml", "discovery.json"].map((name) => {
    const bytes = Buffer.from("benign fixture " + name);
    return {
      nativePath: `C:\\fixture\\${name}`,
      identity: "[1,2,3,4,5,6,7,8,9,1,0]",
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  return {
    ...base,
    installedBuild: bootstrapInstalledFilesDigest(base.installedFiles),
    originalPaths: [
      ...base.originalPaths,
      ...originals.map((x) => x.nativePath),
    ],
    mappedOriginalPaths: {
      ...base.mappedOriginalPaths,
      ...Object.fromEntries(
        originals.map((x, i) => [x.nativePath, `/fixture/owned-${i}`]),
      ),
    },
    owned: {
      ...normal,
      admissionPins: { source: "7".repeat(40), build: "8".repeat(64) },
      autorunOriginals: [originals[0]!, originals[1]!],
      discoveryOriginals: [originals[2]!],
    },
    assertBeforeResumeOriginals() {},
  };
}
function replacementPins(): OwnedAutoloadLaunchPins {
  const p = ownedPins();
  const original = (nativePath: string) => {
    const bytes = Buffer.from("original replacement fixture " + nativePath);
    return {
      nativePath,
      bytes,
      identity: "[1,2,3,4,5,6,7,8,9,1,0]",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const replacement = {
    kind: "unregistered-created-process-v1" as const,
    priorProvision: original("C:\\fixture\\original-prior-provision.json"),
    provisionReceipt: original("C:\\fixture\\original-bound-receipt.json"),
    retiredProcess: original(p.owned.retiredProcessPath),
  };
  const added = [replacement.priorProvision, replacement.provisionReceipt];
  return {
    ...p,
    owned: { ...p.owned, replacement },
    originalPaths: [
      ...p.originalPaths,
      ...added.map((file) => file.nativePath),
    ],
    mappedOriginalPaths: {
      ...p.mappedOriginalPaths,
      ...Object.fromEntries(
        added.map((file, i) => [file.nativePath, `/fixture/replacement-${i}`]),
      ),
    },
  };
}
test("owned replacement requires distinct pinned originals without exposing another launch surface", () => {
  assert.deepEqual(
    Object.keys(createOwnedAutoloadLaunchAdapter(replacementPins())),
    ["launchAfterDeath"],
  );
  for (const change of [
    (p: OwnedAutoloadLaunchPins) =>
      Object.assign(p.owned.replacement!, { kind: "unproved" }),
    (p: OwnedAutoloadLaunchPins) =>
      Object.assign(p.owned.replacement!, { extra: true }),
    (p: OwnedAutoloadLaunchPins) =>
      Object.assign(p.owned.replacement!.priorProvision, {
        sha256: "f".repeat(64),
      }),
    (p: OwnedAutoloadLaunchPins) =>
      Object.assign(p.owned.replacement!.retiredProcess, {
        nativePath: p.owned.replacement!.priorProvision.nativePath,
      }),
    (p: OwnedAutoloadLaunchPins) =>
      Object.assign(p.owned.replacement!.priorProvision, {
        nativePath: p.paths.profile,
      }),
  ]) {
    const p = replacementPins();
    change(p);
    assert.throws(() => createOwnedAutoloadLaunchAdapter(p));
  }
});
test("owned replacement mapped proof drift refuses before native executable access", async (t) => {
  const root = fs.mkdtempSync("/tmp/opencode/owned-replacement-proof-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = replacementPins(),
    proof = p.owned.replacement!;
  const inputs = [
    ...p.owned.autorunOriginals,
    ...p.owned.discoveryOriginals,
    proof.priorProvision,
    proof.provisionReceipt,
    proof.retiredProcess,
  ];
  const mappedOriginalPaths = { ...p.mappedOriginalPaths };
  for (const [i, input] of inputs.entries()) {
    const file = path.join(root, `original-${i}`);
    fs.writeFileSync(file, input.bytes);
    mappedOriginalPaths[input.nativePath] = file;
  }
  const adapter = createOwnedAutoloadLaunchAdapter({
    ...p,
    mappedOriginalPaths,
  });
  fs.writeFileSync(
    mappedOriginalPaths[proof.provisionReceipt.nativePath]!,
    "changed",
  );
  await assert.rejects(
    adapter.launchAfterDeath({ pid: 38, birth: "38" }, "a".repeat(32)),
    /Mapped bytes or identity changed/,
  );
  await assert.rejects(
    adapter.launchAfterDeath({ pid: 38, birth: "38" }, "b".repeat(32)),
    /replayed/,
  );
});
test("owned replacement verifies the original chain and real SQLite guards without replay or writes", () => {
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-B",
      path.join(process.cwd(), "tests/fixtures/owned-replacement-contract.py"),
    ],
    { input: ownedAutoloadLaunchNative(), encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.count, 8);
  assert.equal(evidence.actualFusion, "NOTRUN");
  assert.equal(evidence.cases[0].outcome, "VERIFIED_PRE_MUTATION_FENCE");
  for (const item of evidence.cases) {
    assert.equal(item.SDK, 0);
    assert.equal(item.processOperations, 0);
  }
});
test("owned producer exposes only its disjoint one-shot launch API and requires original nonempty allowlisted inputs", () => {
  assert.deepEqual(Object.keys(createOwnedAutoloadLaunchAdapter(ownedPins())), [
    "launchAfterDeath",
  ]);
  for (const change of [
    (p: OwnedAutoloadLaunchPins) =>
      Object.assign(p.owned.admissionPins, { source: "" }),
    (p: OwnedAutoloadLaunchPins) =>
      Object.assign(p.owned.admissionPins, { extra: true }),
    (p: OwnedAutoloadLaunchPins) =>
      Object.assign(p, { installedBuild: "f".repeat(64) }),
    (p: OwnedAutoloadLaunchPins) =>
      Object.assign(p.owned, { discoveryOriginals: [] }),
    (p: OwnedAutoloadLaunchPins) =>
      Object.assign(p.owned, { autorunOriginals: [] }),
    (p: OwnedAutoloadLaunchPins) =>
      Object.assign(p.owned.autorunOriginals[0], {
        nativePath: p.paths.provision,
      }),
    (p: OwnedAutoloadLaunchPins) =>
      Object.assign(p.owned.autorunOriginals[0], { sha256: "f".repeat(64) }),
    (p: OwnedAutoloadLaunchPins) =>
      Object.assign(p, { assertBeforeResumeOriginals: null }),
  ]) {
    const p = ownedPins();
    change(p);
    assert.throws(() => createOwnedAutoloadLaunchAdapter(p));
  }
});
test("owned original fence is synchronous and irrevocably refuses launch before any native executable access", async () => {
  for (const boundary of [
    () => {
      throw new Error("ORIGINAL_WITNESS_LOST");
    },
    async () => {},
  ]) {
    const adapter = createOwnedAutoloadLaunchAdapter({
      ...ownedPins(),
      assertBeforeResumeOriginals: boundary,
    });
    await assert.rejects(
      adapter.launchAfterDeath({ pid: 1, birth: "1" }, "a".repeat(32)),
      /ORIGINAL_WITNESS_LOST|Synchronous/,
    );
    await assert.rejects(
      adapter.launchAfterDeath({ pid: 1, birth: "1" }, "b".repeat(32)),
      /replayed/,
    );
  }
});
test("owned mapped symlink and hardlink inputs refuse before native executable access", async (t) => {
  const root = fs.mkdtempSync("/tmp/opencode/owned-mapped-originals-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const alias of ["symlink", "hardlink"]) {
    const p = ownedPins();
    const refs = [...p.owned.autorunOriginals, ...p.owned.discoveryOriginals];
    const mappings = { ...p.mappedOriginalPaths };
    for (const [i, ref] of refs.entries()) {
      const name = path.join(root, `${alias}-${i}`);
      fs.writeFileSync(name, ref.bytes);
      mappings[ref.nativePath] = name;
    }
    const original = mappings[refs[0]!.nativePath]!;
    const linked = original + ".alias";
    if (alias === "symlink") fs.symlinkSync(original, linked);
    else fs.linkSync(original, linked);
    mappings[refs[0]!.nativePath] = linked;
    const adapter = createOwnedAutoloadLaunchAdapter({
      ...p,
      mappedOriginalPaths: mappings,
    });
    await assert.rejects(
      adapter.launchAfterDeath({ pid: 1, birth: "1" }, "a".repeat(32)),
      /Mapped owned input (alias|hardlink) refused/,
    );
    await assert.rejects(
      adapter.launchAfterDeath({ pid: 1, birth: "1" }, "b".repeat(32)),
      /replayed/,
    );
  }
});

test("normal private constructor accepts a separate closed actual bytecode inventory without claiming isolation", () => {
  const options = pins();
  assert.notEqual(
    options.installedBuild,
    bootstrapInstalledFilesDigest(options.installedFiles),
  );
  const adapter = createNormalObserverLaunchAdapter(options);
  assert.deepEqual(Object.keys(adapter), [
    "requestNormalCloseAndWait",
    "launchAfterDeath",
  ]);
});

test("standard staged runtime includes the private normal adapter and native extension", () => {
  const staged: typeof import("../packages/node-adapters/src/execution/controlled-fusion-launch") =
    createRequire(__filename)(
      path.resolve(
        "src/dist/node-adapters/execution/controlled-fusion-launch.js",
      ),
    );
  assert.deepEqual(
    Object.keys(staged.createNormalObserverLaunchAdapter(pins())),
    ["requestNormalCloseAndWait", "launchAfterDeath"],
  );
  assert.deepEqual(
    Object.keys(staged.createOwnedAutoloadLaunchAdapter(ownedPins())),
    ["launchAfterDeath"],
  );
});

test("unqualified normal source/aliases/original inputs are rejected before any native spawn", () => {
  const cases: Array<(p: NormalObserverLaunchPins) => void> = [
    (p) => {
      Object.assign(p.normal, {
        installedFiles: {
          ...p.normal.installedFiles,
          "addon_runtime.py": "0".repeat(64),
        },
      });
    },
    (p) => {
      Object.assign(p.normal, {
        installedFiles: {
          ...p.normal.installedFiles,
          "../outside": "a".repeat(64),
        },
      });
    },
    (p) => {
      Object.assign(p.normal, { provisionSha256: "not-a-hash" });
    },
    (p) => {
      Object.assign(p.normal, { provisionBackupPath: p.paths.provision });
    },
    (p) => {
      Object.assign(p.normal.database, { identity: "[]" });
    },
    (p) => {
      Object.assign(p, { assertHeld: null });
    },
  ];
  for (const change of cases) {
    const options = pins();
    change(options);
    assert.throws(() => createNormalObserverLaunchAdapter(options));
  }
});

test("lost or asynchronous lifecycle boundary denies before opening an executable and cannot be replayed", async () => {
  for (const boundary of [
    () => {
      throw new Error("OWNED_LEASE_LOST");
    },
    async () => {},
  ]) {
    const adapter = createNormalObserverLaunchAdapter({
      ...pins(),
      assertHeld: boundary,
    });
    await assert.rejects(
      adapter.launchAfterDeath({ pid: 1, birth: "1" }, "a".repeat(32)),
      /LEASE_LOST|Synchronous/,
    );
    await assert.rejects(
      adapter.launchAfterDeath({ pid: 1, birth: "1" }, "a".repeat(32)),
      /replayed/,
    );
  }
});

test("an unknown normal close poisons its launch path without retrying OS input", async () => {
  const adapter = createNormalObserverLaunchAdapter({
    ...pins(),
    assertHeld() {
      throw new Error("OWNED_CLOSE_LEASE_LOST");
    },
  });
  await assert.rejects(
    adapter.requestNormalCloseAndWait({ pid: 1, birth: "1" }),
    /LEASE_LOST/,
  );
  await assert.rejects(
    adapter.requestNormalCloseAndWait({ pid: 1, birth: "1" }),
    /replayed/,
  );
  await assert.rejects(
    adapter.launchAfterDeath({ pid: 1, birth: "1" }, "a".repeat(32)),
    /unknown close/,
  );
});
