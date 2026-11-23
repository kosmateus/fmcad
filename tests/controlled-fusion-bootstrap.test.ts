import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
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
function fixture(
  options: {
    partial?: boolean;
    wrongProcess?: boolean;
    vendorNormalize?: boolean;
    cancelAfterLaunch?: AbortController;
  } = {},
  create = createControlledFusionBootstrap,
) {
  const events: string[] = [];
  const files = new Map<string, ControlledFile>();
  let serial = 1,
    dead = false,
    started = false,
    leaseCurrent = true,
    sourceCurrent = true;
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
      return {
        process: options.wrongProcess ? old : fresh,
        attempt: file(actualPaths.launchAttempt),
        journal: file(actualPaths.launchJournal),
        sourceClosure: file(actualPaths.sourceClosure),
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
        installed: {
          directory: string;
          source: string;
          files: Record<string, string>;
        };
        profile: { path: string; sha256: string };
      };
      const base = {
        kind: "fmcad-bootstrap-entry-receipt",
        version: 1,
        nonce: expected.nonce,
        process: fresh,
        purpose: "isolated-stdout-v1",
        engineVersion: 2,
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
        encode({ ...base, phase: "entry-before-addon-import" }),
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
        fence() {
          if (!leaseCurrent) throw new Error("lease revoked");
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
    controller,
    ports,
    native,
    files,
    file,
    events,
    revoke: () => {
      leaseCurrent = false;
    },
    tamperSource: () => {
      sourceCurrent = false;
    },
  };
}

test("one-shot controller orders retirement/death/profile/launch/rebind/fresh manager/intent/start/original receipts", async () => {
  const f = fixture({ vendorNormalize: true });
  const transcript = await f.controller.run();
  assert.equal(transcript.state, "COMPLETED", transcript.error ?? "");
  assert.equal(transcript.authority, "NONE");
  for (const [before, after] of [
    ["lease", "retire"],
    ["retire", "dead"],
    ["dead", "qualified-install"],
    ["qualified-install", "profile-read"],
    ["profile-read", "backup-apply"],
    ["backup-apply", "launch"],
    ["launch", "rebind"],
    ["rebind", "prepare-ui"],
    ["prepare-ui", "intent"],
    ["intent", "start-once"],
    ["start-once", "receipts"],
  ]) {
    assert.ok(
      f.events.indexOf(before!) < f.events.indexOf(after!),
      `${before} before ${after}`,
    );
  }
  assert.equal(f.events.filter((event) => event === "launch").length, 1);
  assert.equal(f.events.filter((event) => event === "start-once").length, 1);
  await f.controller.assertOriginalTranscript(transcript);
  const witness = await f.controller.prepareOriginalWitness(transcript);
  assert.equal(witness.fence(), undefined);
  f.controller.assertPreparedWitness(witness);
  assert.throws(
    () => f.controller.assertPreparedWitness({ ...witness }),
    /Foreign/,
  );
  const persisted =
    await f.controller.readOriginalTranscriptReference(transcript);
  assert.equal(persisted.nativePath, f.native.paths.transcript);
  const originals = await f.controller.readOriginalEvidence(transcript);
  const intent = await f.controller.readOriginalIntent(transcript);
  assert.equal(intent.nonce, transcript.nonce);
  assert.deepEqual(intent.process, fresh);
  assert.equal(path.win32.basename(originals.intent.nativePath), "intent.json");
  await assert.rejects(f.controller.run(), /replayed/);
});

test("a mistakenly asynchronous local fence cannot pass the synchronous final seam", async () => {
  const f = fixture();
  const acquire = f.ports.acquireExclusiveLifecycleLease;
  f.ports.acquireExclusiveLifecycleLease = async () => ({
    ...(await acquire()),
    async fence() {
      await Promise.resolve();
    },
  });
  const result = await f.controller.run();
  assert.equal(result.state, "COMPLETED");
  await assert.rejects(
    f.controller.prepareOriginalWitness(result),
    /Synchronous/,
  );
  await assert.rejects(
    f.controller.assertOriginalTranscript(result),
    /Original/,
  );
});

test("foreign/serialized/UNKNOWN/partial transcripts are not operator-origin witnesses", async () => {
  const f = fixture();
  const transcript = await f.controller.run();
  await assert.rejects(
    f.controller.assertOriginalTranscript(structuredClone(transcript)),
    /Original/,
  );
  const foreign = fixture();
  await assert.rejects(
    foreign.controller.assertOriginalTranscript(transcript),
    /Original/,
  );
  for (const options of [{ partial: true }, { wrongProcess: true }]) {
    const failed = fixture(options);
    const result = await failed.controller.run();
    assert.equal(result.state, "UNKNOWN");
    await assert.rejects(
      failed.controller.assertOriginalTranscript(result),
      /Original/,
    );
    await assert.rejects(failed.controller.run(), /replayed/);
    assert.equal(failed.events.filter((event) => event === "launch").length, 1);
  }
});

test("held window/file/source revocation permanently invalidates original transcript without re-launch", async () => {
  for (const mode of ["lease", "file", "source"]) {
    const f = fixture();
    const result = await f.controller.run();
    assert.equal(result.state, "COMPLETED");
    if (mode === "lease") f.revoke();
    if (mode === "source") f.tamperSource();
    if (mode === "file")
      f.file(f.native.paths.entry, Buffer.from("changed original"));
    await assert.rejects(f.controller.assertOriginalTranscript(result));
    await assert.rejects(f.controller.readOriginalEvidence(result));
    assert.equal(f.events.filter((event) => event === "launch").length, 1);
  }
});

test("cancellation before or after launch never causes a second launch, UI input or overwrite", async () => {
  const before = new AbortController();
  before.abort();
  const early = fixture();
  assert.equal((await early.controller.run(before.signal)).state, "UNKNOWN");
  assert.equal(early.events.includes("launch"), false);
  const abort = new AbortController();
  const late = fixture({ cancelAfterLaunch: abort });
  const unknown = await late.controller.run(abort.signal);
  assert.equal(unknown.state, "UNKNOWN");
  assert.equal(late.events.filter((event) => event === "launch").length, 1);
  assert.equal(late.events.includes("start-once"), false);
  const original = late.files.get(late.native.paths.transcript);
  await assert.rejects(late.controller.run(), /replayed/);
  assert.equal(late.files.get(late.native.paths.transcript), original);
});

test("normal staged controller imports and runs without workspace packages or test-derived package outputs", async () => {
  const root = fs.mkdtempSync("/tmp/opencode/controlled-launch-staged-");
  const destination = path.join(root, "src");
  const adapters = path.join(destination, "dist/node-adapters/execution");
  fs.mkdirSync(adapters, { recursive: true });
  fs.copyFileSync(
    path.resolve("src/controlled-fusion-bootstrap.js"),
    path.join(destination, "controlled-fusion-bootstrap.js"),
  );
  for (const name of [
    "controlled-fusion-launch",
    "controlled-fusion-launch-native",
    "bootstrap-entry-evidence",
    "fusion-bootstrap-autoload",
    "admission-json",
  ])
    fs.copyFileSync(
      path.resolve(`src/dist/node-adapters/execution/${name}.js`),
      path.join(adapters, `${name}.js`),
    );
  assert.equal(fs.existsSync(path.join(root, "packages")), false);
  const isolated = createRequire(path.join(root, "entry.cjs"))(
    "./src/controlled-fusion-bootstrap.js",
  ) as typeof import("../src/controlled-fusion-bootstrap");
  const f = fixture({}, isolated.createControlledFusionBootstrap);
  const transcript = await f.controller.run();
  assert.equal(transcript.state, "COMPLETED", transcript.error ?? "");
  await f.controller.assertOriginalTranscript(transcript);
});
