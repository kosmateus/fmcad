import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { controlledFusionBootstrapFixture } from "./controlled-fusion-bootstrap-fixture";

test("one-shot controller orders retirement/death/profile/launch/rebind/fresh manager/intent/start/original receipts", async () => {
  const f = controlledFusionBootstrapFixture({ vendorNormalize: true });
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
  assert.equal(intent.version, 2);
  assert.equal(intent.purpose, "isolated-stdout-v1");
  assert.deepEqual(intent.executable, {
    path: "C:\\Program Files\\Autodesk\\Fusion\\Fusion.exe",
    sha256: "f".repeat(64),
  });
  assert.deepEqual(
    JSON.parse(Buffer.from(originals.intent.bytes).toString("utf8")),
    intent,
    "the emitted intent bytes are the exact original v2 intent",
  );
  const entry = JSON.parse(Buffer.from(originals.entry.bytes).toString("utf8"));
  const returned = JSON.parse(
    Buffer.from(originals.returned.bytes).toString("utf8"),
  );
  assert.equal(entry.version, 2);
  assert.equal(entry.phase, "entry-audited-before-addon-import");
  assert.equal(entry.executable.path, intent.executable.path);
  assert.equal(entry.startupAudit.scripts.countBefore, 2);
  assert.equal(entry.startupAudit.scripts.items[1].isVisible, false);
  assert.equal(returned.version, 2);
  assert.equal(returned.phase, "run-returned");
  assert.equal(
    returned.entry.sha256,
    f.files.get(f.native.paths.entry)?.sha256,
  );
  assert.equal("startupAudit" in returned, false);
  assert.equal(intent.nonce, transcript.nonce);
  assert.deepEqual(intent.process, f.fresh);
  assert.equal(path.win32.basename(originals.intent.nativePath), "intent.json");
  await assert.rejects(f.controller.run(), /replayed/);
});

test("a launch journal with a different executable pin cannot emit an intent or start the add-in", async () => {
  const f = controlledFusionBootstrapFixture({
    tamperExecutableJournal: true,
  });
  const transcript = await f.controller.run();
  assert.equal(transcript.state, "UNKNOWN");
  assert.match(transcript.error ?? "", /executable binding differs/);
  assert.equal(f.events.includes("intent"), false);
  assert.equal(f.events.includes("start-once"), false);
  assert.equal(f.files.has(f.native.paths.intent), false);
});

test("a mistakenly asynchronous local fence cannot pass the synchronous final seam", async () => {
  const f = controlledFusionBootstrapFixture();
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
  const f = controlledFusionBootstrapFixture();
  const transcript = await f.controller.run();
  await assert.rejects(
    f.controller.assertOriginalTranscript(structuredClone(transcript)),
    /Original/,
  );
  const foreign = controlledFusionBootstrapFixture();
  await assert.rejects(
    foreign.controller.assertOriginalTranscript(transcript),
    /Original/,
  );
  for (const options of [{ partial: true }, { wrongProcess: true }]) {
    const failed = controlledFusionBootstrapFixture(options);
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
    const f = controlledFusionBootstrapFixture();
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
  const early = controlledFusionBootstrapFixture();
  assert.equal((await early.controller.run(before.signal)).state, "UNKNOWN");
  assert.equal(early.events.includes("launch"), false);
  const abort = new AbortController();
  const late = controlledFusionBootstrapFixture({ cancelAfterLaunch: abort });
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
    "owned-autoload-launch-native",
    "owned-identity-preparation-native",
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
  const f = controlledFusionBootstrapFixture(
    {},
    isolated.createControlledFusionBootstrap,
  );
  const transcript = await f.controller.run();
  assert.equal(transcript.state, "COMPLETED", transcript.error ?? "");
  await f.controller.assertOriginalTranscript(transcript);
});
