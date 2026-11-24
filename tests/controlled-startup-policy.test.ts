import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  prepareControlledStartupInputs,
  assertControlledStartupInputs,
  verifyControlledStartupInputs,
  readControlledStartupInputs,
} from "../packages/node-adapters/src/execution/controlled-startup-inputs";
import {
  assertControlledStartupData,
  type StartupPolicyAudit,
  type StartupPolicyExpected,
} from "../packages/node-adapters/src/execution/controlled-startup-policy";

function fixture() {
  const expected: StartupPolicyExpected = {
    defaultApiParent: "C:\\Users\\owner\\API",
    installedDirectory: "C:\\Users\\owner\\API\\AddIns\\Fork",
    installedManifestHash: "a".repeat(64),
    autorunPaths: [
      "C:\\Users\\owner\\Fusion\\PythonAutorunModuleinfo",
      "C:\\Users\\owner\\Fusion\\profile\\PythonAutorunModuleinfo",
    ],
  };
  const audit: StartupPolicyAudit = {
    preferences: { defaultPathForScriptsAndAddIns: "C:/Users/owner/API/" },
    scripts: {
      countBefore: 2,
      countAfter: 2,
      items: [
        {
          folder: "C:/Users/owner/API/AddIns/Fork",
          isAddIn: true,
          isRunOnStartup: false,
          isRunning: true,
          manifest: { sha256: expected.installedManifestHash },
        },
        {
          folder: "C:/Vendor/SampleScript",
          isAddIn: false,
          isRunOnStartup: null,
          isRunning: false,
          manifest: { sha256: "b".repeat(64) },
        },
      ],
    },
  };
  const original = (
    nativePath: string,
    content = '{"enabledModules":[],"lastAppInstallTime":0}',
  ) => {
    const bytes = Buffer.from(content);
    return {
      nativePath,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  };
  return {
    expected,
    audit,
    original,
    autorun: expected.autorunPaths.map((name) => original(name)),
  };
}
test("complete disabled startup data passes without returning any authority", () => {
  const f = fixture();
  assert.equal(
    assertControlledStartupData(f.audit, f.expected, f.autorun),
    undefined,
  );
});
for (const fault of [
  "parent",
  "manifest",
  "missing-self",
  "duplicate-folder",
  "foreign-running",
  "foreign-startup",
  "self-startup",
  "count",
] as const)
  test(`startup policy refuses ${fault}`, () => {
    const f = fixture();
    const rows = f.audit.scripts.items.map((row) => ({ ...row }));
    if (fault === "manifest") rows[0]!.manifest = { sha256: "c".repeat(64) };
    if (fault === "missing-self")
      Object.assign(rows[0]!, { folder: "C:/Other/Fork", isRunning: false });
    if (fault === "duplicate-folder") rows[1]!.folder = rows[0]!.folder;
    if (fault === "foreign-running") rows[1]!.isRunning = true;
    if (fault === "foreign-startup")
      Object.assign(rows[1]!, { isAddIn: true, isRunOnStartup: true });
    if (fault === "self-startup") rows[0]!.isRunOnStartup = true;
    const audit = {
      ...f.audit,
      preferences:
        fault === "parent"
          ? { defaultPathForScriptsAndAddIns: "C:/Other/API" }
          : f.audit.preferences,
      scripts: {
        ...f.audit.scripts,
        items: rows,
        countAfter: fault === "count" ? 3 : 2,
      },
    };
    assert.throws(
      () => assertControlledStartupData(audit, f.expected, f.autorun),
      { code: "CONTROLLED_STARTUP_UNPROVEN" },
    );
  });
test("both distinct original autorun inputs are mandatory, even with an empty SDK collection claim", () => {
  const f = fixture();
  for (const files of [
    [],
    f.autorun.slice(0, 1),
    [f.autorun[0]!, f.autorun[0]!],
  ])
    assert.throws(
      () => assertControlledStartupData(f.audit, f.expected, files),
      { code: "CONTROLLED_STARTUP_UNPROVEN" },
    );
});
for (const content of [
  '{"enabledModules":["foreign.module"],"lastAppInstallTime":0}',
  '{"enabledModules":[],"enabledModules":[],"lastAppInstallTime":0}',
  '{"enabledModules":[],"lastAppInstallTime":NaN}',
  '{"enabledModules":[],"lastAppInstallTime":0,"complete":true}',
  '{"enabledModules":[]}',
])
  test(`autorun data refuses ${content}`, () => {
    const f = fixture();
    f.autorun[1] = f.original(f.expected.autorunPaths[1], content);
    assert.throws(
      () => assertControlledStartupData(f.audit, f.expected, f.autorun),
      { code: "CONTROLLED_STARTUP_UNPROVEN" },
    );
  });
test("changed original bytes, foreign paths and invalid UTF-8 are not disabled-autorun proofs", () => {
  const f = fixture();
  for (const altered of [
    { ...f.autorun[1]!, bytes: Buffer.from("changed") },
    f.original("C:/Other/PythonAutorunModuleinfo"),
    {
      ...f.autorun[1]!,
      bytes: Buffer.from([0xff]),
      sha256: createHash("sha256")
        .update(Buffer.from([0xff]))
        .digest("hex"),
    },
  ])
    assert.throws(
      () =>
        assertControlledStartupData(f.audit, f.expected, [
          f.autorun[0]!,
          altered,
        ]),
      { code: "CONTROLLED_STARTUP_UNPROVEN" },
    );
});

function nativeFixture() {
  const f = fixture();
  let held = true,
    changed = false,
    beforeLaunch = true;
  let afterRead: (() => void) | undefined;
  const files = f.autorun.map((file, index) => ({
    ...file,
    identity: `native-identity-${index}`,
  }));
  const ports = {
    expected: f.expected,
    assertBeforeLaunch() {
      if (!beforeLaunch) throw new Error("Launch already began");
    },
    assertHeld() {
      if (!held) throw new Error("Original lease revoked");
    },
    async assertHeldCurrent() {
      ports.assertHeld();
    },
    native: {
      async preflight() {
        if (changed) throw new Error("Original source changed");
      },
      async readOriginal(file: string) {
        const result = files.find((original) => original.nativePath === file);
        assert.ok(result);
        afterRead?.();
        return result;
      },
      async assertOriginal(file: (typeof files)[number]) {
        if (
          changed ||
          !files.some(
            (original) =>
              original.nativePath === file.nativePath &&
              original.sha256 === file.sha256 &&
              original.identity === file.identity,
          )
        )
          throw new Error("Native original changed");
      },
      captureSynchronousFence() {
        return () => {
          if (changed) throw new Error("Mapped source/input changed");
        };
      },
    },
  };
  return {
    ...f,
    ports,
    loseLease() {
      held = false;
    },
    replace(value: boolean) {
      changed = value;
    },
    onRead(callback: () => void) {
      afterRead = callback;
    },
    launch() {
      beforeLaunch = false;
    },
  };
}
test("private startup inputs bind both original native files and return copies, not grants", async () => {
  const f = nativeFixture();
  const original = await prepareControlledStartupInputs(f.ports);
  await verifyControlledStartupInputs(original);
  const data = readControlledStartupInputs(original);
  assert.equal(data.files.length, 2);
  assert.deepEqual(data.expected, f.expected);
  data.files[0]!.bytes[0] = 0;
  assert.notEqual(readControlledStartupInputs(original).files[0]!.bytes[0], 0);
  assert.throws(() => assertControlledStartupInputs(structuredClone(original)));
  assertControlledStartupInputs(original);
});
test("loss of original startup source/input identity permanently revokes the private witness", async () => {
  const f = nativeFixture();
  const original = await prepareControlledStartupInputs(f.ports);
  f.replace(true);
  await assert.rejects(verifyControlledStartupInputs(original));
  f.replace(false);
  assert.throws(() => assertControlledStartupInputs(original));
  assert.throws(() => readControlledStartupInputs(original));
});
test("lease loss across an original native read denies startup input preparation", async () => {
  const f = nativeFixture();
  f.onRead(() => f.loseLease());
  await assert.rejects(
    prepareControlledStartupInputs(f.ports),
    /lease revoked/,
  );
});
test("asynchronous pretend held flags cannot attest startup inputs", async () => {
  const f = nativeFixture();
  await assert.rejects(
    prepareControlledStartupInputs({
      ...f.ports,
      assertHeld: async () => {},
    }),
    /Original held/,
  );
  const untypedCaller = { ...f.ports };
  Object.defineProperty(untypedCaller, "assertHeldCurrent", {
    value: async () => true,
  });
  await assert.rejects(
    prepareControlledStartupInputs(untypedCaller),
    /Original held/,
  );
  await assert.rejects(
    prepareControlledStartupInputs({
      ...f.ports,
      assertBeforeLaunch: async () => {},
    }),
    /Original held/,
  );
});
test("startup input capture cannot begin after launch or complete across the launch boundary", async () => {
  const early = nativeFixture();
  early.launch();
  await assert.rejects(
    prepareControlledStartupInputs(early.ports),
    /Launch already began/,
  );
  const during = nativeFixture();
  during.onRead(() => during.launch());
  await assert.rejects(
    prepareControlledStartupInputs(during.ports),
    /Launch already began/,
  );
});
