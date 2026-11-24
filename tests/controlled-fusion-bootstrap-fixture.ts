import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { ControlledStartupInputs } from "../packages/node-adapters/src/execution/controlled-startup-inputs";
import {
  createControlledFusionBootstrap,
  type ControlledFusionBootstrapPorts,
} from "../src/controlled-fusion-bootstrap";
import { bootstrapInstalledFilesDigest } from "../packages/node-adapters/src/execution/bootstrap-entry-evidence";
import type {
  ControlledFile,
  ControlledNativeAdapter,
} from "../packages/node-adapters/src/execution/controlled-fusion-launch-types";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const old = { pid: 20, birth: "100" },
  fresh = { pid: 21, birth: "200" };
export function controlledStartupAuditFixture() {
  const addInManifest = '{"id":"controlled-fork"}';
  const hiddenScriptManifest = '{ "id": "hidden-peer", "version": 1 }';
  return {
    kind: "fmcad-startup-sdk-audit",
    version: 1,
    applicationVersion: "2.0.0 fixture",
    preferences: {
      defaultPathForScriptsAndAddIns: "C:\\Users\\fixture\\Fusion",
    },
    scripts: {
      countBefore: 2,
      countAfter: 2,
      items: [
        {
          index: 0,
          folder: "C:\\fixture\\fork",
          location: {
            name: "UserDefinedScriptSourceLocation",
            value: 2,
          },
          isAddIn: true,
          isRunOnStartup: false,
          isRunning: true,
          isVisible: true,
          manifest: {
            content: addInManifest,
            sha256: hash(Buffer.from(addInManifest, "utf8")),
            parseStatus: "json-object",
          },
        },
        {
          index: 1,
          folder: "C:\\Users\\fixture\\Fusion\\Scripts\\peer",
          location: {
            name: "SamplesScriptSourceLocation",
            value: 4,
          },
          isAddIn: false,
          isRunOnStartup: null,
          isRunning: false,
          isVisible: false,
          manifest: {
            content: hiddenScriptManifest,
            sha256: hash(Buffer.from(hiddenScriptManifest, "utf8")),
            parseStatus: "json-object",
          },
        },
      ],
    },
  };
}
export function controlledFusionBootstrapFixture(
  options: {
    partial?: boolean;
    wrongProcess?: boolean;
    tamperExecutableJournal?: boolean;
    vendorNormalize?: boolean;
    cancelAfterLaunch?: AbortController;
    captureStartupInputs?: boolean;
  } = {},
  create = createControlledFusionBootstrap,
) {
  const events: string[] = [];
  const files = new Map<string, ControlledFile>();
  let startupInputs: ControlledStartupInputs | undefined;
  let serial = 1,
    dead = false,
    started = false,
    leaseCurrent = true,
    sourceCurrent = true,
    rejectNextLeaseFence = false,
    rejectedLeaseFenceCount = 0;
  const paths = Object.fromEntries(
    [
      "profile",
      "profileBackup",
      "intent",
      "receiptDirectory",
      "entry",
      "returned",
      "launchAttempt",
      "launchJournal",
      "sourceClosure",
      "transcript",
      "provision",
    ].map((name) => [name, `C:\\fixture\\${name}.json`]),
  ) as unknown as ControlledNativeAdapter["paths"];
  const actualPaths = {
    ...paths,
    profile: "C:\\fixture\\user\\JSLoadedScriptsinfo",
    receiptDirectory: "C:\\fixture",
    entry: "C:\\fixture\\entry.json",
    returned: "C:\\fixture\\returned.json",
  };
  const installedDirectory = "C:\\fixture\\fork";
  const fork = `${installedDirectory}\\AutodeskFusionMCP.py`;
  const installedFiles = Object.fromEntries(
    ["AutodeskFusionMCP.py", "addon_runtime.py", "lib/bootstrap_entry.py"].map(
      (name) => [name, hash(Buffer.from(name))],
    ),
  );
  installedFiles["AutodeskFusionMCP.manifest"] =
    controlledStartupAuditFixture().scripts.items[0]!.manifest.sha256;
  const file = (nativePath: string, bytes = encode({ nativePath })) => {
    const result = {
      nativePath,
      bytes,
      sha256: hash(bytes),
      identity: `native-file-${serial++}`,
    };
    files.set(nativePath, result);
    return result;
  };
  file(
    actualPaths.profile,
    encode({
      loadedScripts: [
        {
          name: "fork",
          path: fork,
          location: 1,
          isRemoved: false,
          isFavorite: false,
          runOnStartup: true,
        },
        {
          name: "peer",
          path: "Vendor/Other",
          location: 2,
          isRemoved: false,
          isFavorite: true,
          runOnStartup: true,
        },
      ],
    }),
  );
  const currentFile = (nativePath: string) => {
    const result = files.get(nativePath);
    if (!result) throw new Error("Original absent");
    return result;
  };
  const native: ControlledNativeAdapter = {
    paths: actualPaths,
    installedDirectory,
    installedSource: "a".repeat(40),
    installedBuild: bootstrapInstalledFilesDigest(installedFiles),
    installedFiles,
    nativePathMappings: {},
    async preflight() {
      events.push("preflight");
      if (!sourceCurrent) throw new Error("source changed");
    },
    async requestNormalCloseAndWait() {
      throw new Error("Fixture has no vendor GUI");
    },
    async confirmDead(value) {
      events.push("dead");
      assert.deepEqual(value, old);
      if (!dead) throw new Error("old still alive");
    },
    async readProfileAfterDeath(value) {
      assert.deepEqual(value, old);
      assert.equal(dead, true);
      events.push("profile-read");
      return currentFile(actualPaths.profile);
    },
    async applyProfileAfterDeath(value, original, bytes) {
      assert.deepEqual(value, old);
      assert.equal(dead, true);
      assert.equal(original, currentFile(actualPaths.profile));
      events.push("backup-apply");
      return {
        backup: file(actualPaths.profileBackup, Buffer.from(original.bytes)),
        profile: file(actualPaths.profile, Buffer.from(bytes)),
      };
    },
    async launch(value, profile, nonce) {
      assert.deepEqual(value, old);
      assert.equal(dead, true);
      assert.equal(profile.sha256, currentFile(actualPaths.profile).sha256);
      assert.match(nonce, /^[a-f0-9]{32}$/);
      events.push("launch");
      options.cancelAfterLaunch?.abort();
      const sourceClosure = file(actualPaths.sourceClosure);
      const executable = "C:\\Program Files\\Autodesk\\Fusion\\Fusion.exe";
      const executableSha256 = "f".repeat(64);
      const reference = (original: ControlledFile) => ({
        nativePath: original.nativePath,
        sha256: original.sha256,
        identity: original.identity,
      });
      const attempt = file(
        actualPaths.launchAttempt,
        encode({
          kind: "controlled-launch-attempt-v1",
          nonce,
          old: value,
          executable,
          executableSha256,
          profile: reference(profile),
          sourceClosure: reference(sourceClosure),
        }),
      );
      const process = options.wrongProcess ? old : fresh;
      const journal = file(
        actualPaths.launchJournal,
        encode({
          kind: "controlled-created-process-v1",
          nonce,
          process,
          executable,
          executableSha256: options.tamperExecutableJournal
            ? "0".repeat(64)
            : executableSha256,
          attempt: reference(attempt),
        }),
      );
      return {
        process,
        attempt,
        journal,
        sourceClosure,
      };
    },
    async assertProcess(value) {
      assert.deepEqual(value, fresh);
      events.push("process-fence");
    },
    async readOriginal(nativePath) {
      events.push("original-read");
      return currentFile(nativePath);
    },
    async publishOriginal(nativePath, bytes) {
      if (files.has(nativePath)) throw new Error("O_EXCL");
      events.push(nativePath === actualPaths.intent ? "intent" : "transcript");
      return file(nativePath, Buffer.from(bytes));
    },
    async assertOriginal(expected) {
      const actual = currentFile(expected.nativePath);
      if (
        actual.sha256 !== expected.sha256 ||
        actual.identity !== expected.identity
      )
        throw new Error("original changed");
    },
    async assertSource() {
      if (!sourceCurrent) throw new Error("source changed");
    },
    captureSynchronousFence(originals) {
      const baseline = originals.map((entry) => ({ ...entry }));
      return () => {
        if (!sourceCurrent) throw new Error("source changed");
        for (const original of baseline) {
          const current = currentFile(original.nativePath);
          if (
            current.sha256 !== original.sha256 ||
            current.identity !== original.identity
          )
            throw new Error("file changed");
        }
      };
    },
    async awaitReceipts(value) {
      assert.deepEqual(value, fresh);
      assert.equal(started, true);
      events.push("receipts");
      if (options.partial) throw new Error("entry without return; unknown");
      const intent = currentFile(actualPaths.intent);
      const expected = JSON.parse(
        Buffer.from(intent.bytes).toString("utf8"),
      ) as {
        nonce: string;
        executable: { path: string; sha256: string };
        installed: {
          directory: string;
          source: string;
          files: Record<string, string>;
        };
        profile: { path: string; sha256: string };
      };
      const base = {
        kind: "fmcad-bootstrap-entry-receipt",
        version: 2,
        nonce: expected.nonce,
        process: fresh,
        purpose: "isolated-stdout-v1",
        engineVersion: 2,
        executable: expected.executable,
        intent: { path: intent.nativePath, sha256: intent.sha256 },
        profile: expected.profile,
        installed: {
          directory: expected.installed.directory,
          source: expected.installed.source,
          filesDigest: bootstrapInstalledFilesDigest(expected.installed.files),
        },
      };
      const entry = file(
        actualPaths.entry,
        encode({
          ...base,
          phase: "entry-audited-before-addon-import",
          startupAudit: controlledStartupAuditFixture(),
        }),
      );
      const returned = file(
        actualPaths.returned,
        encode({
          ...base,
          phase: "run-returned",
          entry: { path: entry.nativePath, sha256: entry.sha256 },
        }),
      );
      return { entry, returned };
    },
  };
  const ports: ControlledFusionBootstrapPorts = {
    native,
    async acquireExclusiveLifecycleLease() {
      events.push("lease");
      return {
        fence(): void {
          if (!leaseCurrent) throw new Error("lease revoked");
          if (rejectNextLeaseFence) {
            rejectNextLeaseFence = false;
            rejectedLeaseFenceCount++;
            return Promise.reject(
              new Error("fixture async lease fence"),
            ) as unknown as void;
          }
        },
        async assertCurrent() {
          if (!leaseCurrent) throw new Error("lease revoked");
        },
        async retireOldNormally(value) {
          assert.deepEqual(value, old);
          events.push("retire");
          dead = true;
        },
      };
    },
    async qualifyNativeInstallationAfterDeath(value) {
      assert.deepEqual(value.old, old);
      assert.equal(value.qualifiedPackagePins.build, native.installedBuild);
      assert.equal(dead, true);
      events.push("qualified-install");
      if (options.captureStartupInputs) {
        const autorunPaths = [
          "C:\\fixture\\PythonAutorunModuleinfo",
          "C:\\fixture\\user\\PythonAutorunModuleinfo",
        ] as const;
        for (const name of autorunPaths)
          file(name, encode({ enabledModules: [], lastAppInstallTime: 0 }));
        const manifestHash =
          native.installedFiles["AutodeskFusionMCP.manifest"];
        assert.ok(manifestHash);
        const { prepareControlledStartupInputs } = createRequire(__filename)(
          "../src/dist/node-adapters/execution/controlled-startup-inputs",
        ) as typeof import("../packages/node-adapters/src/execution/controlled-startup-inputs");
        startupInputs = await prepareControlledStartupInputs({
          native,
          expected: {
            installedDirectory,
            installedManifestHash: manifestHash,
            defaultApiParent:
              controlledStartupAuditFixture().preferences
                .defaultPathForScriptsAndAddIns,
            autorunPaths,
          },
          assertBeforeLaunch() {
            assert.ok(dead && !started, "original prelaunch phase");
          },
          assertHeld() {
            if (!leaseCurrent) throw new Error("lease revoked");
          },
          async assertHeldCurrent() {
            if (!leaseCurrent) throw new Error("lease revoked");
          },
        });
        events.push("original-startup-inputs-held-before-launch");
      }
      return file("C:\\fixture\\qualified-install.json");
    },
    async rebindNative(input) {
      assert.deepEqual(input.launched.process, fresh);
      events.push("rebind");
      return {
        process: fresh,
        reference: file("C:\\fixture\\rebind.json"),
        fence() {
          if (!leaseCurrent) throw new Error("rebind revoked");
        },
        async assertCurrent() {
          if (!leaseCurrent) throw new Error("rebind revoked");
        },
      };
    },
    async prepareExactHost(input) {
      assert.deepEqual(input.process, fresh);
      assert.equal(started, false);
      events.push("prepare-ui");
      if (options.vendorNormalize) {
        const bytes = currentFile(actualPaths.profile).bytes;
        file(
          actualPaths.profile,
          Buffer.from(Buffer.from(bytes).toString("utf8") + "\n\n"),
        );
      }
      return {
        process: fresh,
        selectedEntry: fork,
        reference: file("C:\\fixture\\ui-prepare.json"),
      };
    },
    async startReviewedFork(input) {
      assert.deepEqual(input.process, fresh);
      assert.equal(started, false);
      assert.ok(files.has(actualPaths.intent));
      started = true;
      events.push("start-once");
      return {
        process: fresh,
        selectedEntry: fork,
        reference: file("C:\\fixture\\ui-start.json"),
      };
    },
  };
  const controller = create(old, ports);
  return {
    old,
    fresh,
    controller,
    ports,
    native,
    files,
    file,
    events,
    get startupInputs() {
      return startupInputs;
    },
    revoke: () => {
      leaseCurrent = false;
    },
    tamperSource: () => {
      sourceCurrent = false;
    },
    rejectNextLeaseFence: () => {
      rejectNextLeaseFence = true;
    },
    rejectedLeaseFenceCount: () => rejectedLeaseFenceCount,
  };
}
