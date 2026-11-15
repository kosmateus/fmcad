import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { QueueScenarioBackend } from "./queue-backend";

interface RuntimeBinding {
  root: string;
  dist: string;
  fingerprint: string;
  queueInstancePath: string;
}
interface RuntimeLoader {
  resolveQualifiedLiveRuntime(env?: NodeJS.ProcessEnv): RuntimeBinding;
}
interface LiveRunner {
  prepareBroker(): Promise<RuntimeBinding>;
  captureBaseline(runtime: RuntimeBinding): Promise<unknown>;
}
interface RuntimeFixtureOptions {
  manifestFingerprint?: string;
  actualFingerprint?: string;
  manifest?: boolean;
}
interface RuntimeFixture {
  root: string;
  dist: string;
  queueClientMarker: string;
}

const projectRoot = path.resolve(__dirname, "../../..");
const load = createRequire(path.join(projectRoot, "package.json"));
const loader = load("./tests/helpers/qualified-live-runtime") as RuntimeLoader;
const liveRunner = load("./tests/run-live") as LiveRunner;

function directory(t: TestContext, prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runtimeFixture(
  t: TestContext,
  options: RuntimeFixtureOptions = {},
): RuntimeFixture {
  const root = path.join(directory(t, "fmcad-qualified-runtime-"), "runtime");
  const dist = path.join(root, "dist");
  const distSrc = path.join(dist, "src");
  const source = path.join(root, "src");
  const fingerprint = options.actualFingerprint ?? "a".repeat(64);
  const queueClientMarker = path.join(root, "queue-client-loaded");
  fs.mkdirSync(distSrc, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(
    path.join(source, "queue-instance.js"),
    `module.exports = { buildHash: () => ${JSON.stringify("b".repeat(64))} };\n`,
  );
  fs.writeFileSync(
    path.join(dist, "package.json"),
    JSON.stringify({ name: "fmcad", version: "0.1.0", fmcadRuntimeLayout: 1 }),
  );
  fs.writeFileSync(
    path.join(distSrc, "queue-instance.js"),
    `module.exports = { buildHash: () => ${JSON.stringify(fingerprint)} };\n`,
  );
  fs.writeFileSync(
    path.join(distSrc, "queue-client.js"),
    `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(queueClientMarker)}, "loaded"); module.exports = { QueueClient: class {}, inputFiles: () => [] };\n`,
  );
  if (options.manifest !== false) {
    fs.writeFileSync(
      path.join(dist, "runtime-build.json"),
      JSON.stringify({
        version: 1,
        algorithm: "sha256",
        fingerprint: options.manifestFingerprint ?? fingerprint,
        entrypoints: {
          "queue-worker": "src/queue-worker.js",
          "queue-autostart-worker": "src/queue-autostart-worker.js",
          "queue-broker": "src/queue-broker.js",
        },
      }),
    );
  }
  return { root, dist, queueClientMarker };
}

function projectFixture(t: TestContext): {
  root: string;
  queueClientMarker: string;
} {
  const root = path.join(directory(t, "fmcad-live-project-"), "project");
  const helpers = path.join(root, "tests/helpers");
  const src = path.join(root, "src");
  const queueClientMarker = path.join(root, "source-queue-client-loaded");
  fs.mkdirSync(helpers, { recursive: true });
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fmcad" }),
  );
  fs.copyFileSync(
    path.join(projectRoot, "tests/helpers/qualified-live-runtime.js"),
    path.join(helpers, "qualified-live-runtime.js"),
  );
  fs.writeFileSync(
    path.join(src, "queue-instance.js"),
    `module.exports = { buildHash: () => ${JSON.stringify("b".repeat(64))} };\n`,
  );
  fs.writeFileSync(
    path.join(src, "queue-client.js"),
    `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(queueClientMarker)}, "loaded"); module.exports = { QueueClient: class {}, inputFiles: () => [] };\n`,
  );
  return { root, queueClientMarker };
}

function setRuntimeRoot(t: TestContext, root: string): void {
  const previous = process.env["FMCAD_LIVE_RUNTIME_ROOT"];
  process.env["FMCAD_LIVE_RUNTIME_ROOT"] = root;
  t.after(() => {
    if (previous === undefined) delete process.env["FMCAD_LIVE_RUNTIME_ROOT"];
    else process.env["FMCAD_LIVE_RUNTIME_ROOT"] = previous;
  });
}

test("qualified runtime loader selects the installed dist identity, not source hash", (t) => {
  const runtime = runtimeFixture(t);

  const binding = loader.resolveQualifiedLiveRuntime({
    FMCAD_LIVE_RUNTIME_ROOT: runtime.root,
  });

  assert.equal(binding.root, fs.realpathSync(runtime.root));
  assert.equal(binding.fingerprint, "a".repeat(64));
  assert.equal(
    binding.queueInstancePath,
    path.join(runtime.dist, "src/queue-instance.js"),
  );
});

test("qualified runtime loader refuses absent manifests and a wrong fingerprint pin", (t) => {
  const missing = runtimeFixture(t, { manifest: false });
  assert.throws(
    () =>
      loader.resolveQualifiedLiveRuntime({
        FMCAD_LIVE_RUNTIME_ROOT: missing.root,
      }),
    /Runtime build manifest is missing or unreadable.*no queue SDK was loaded/u,
  );

  const wrong = runtimeFixture(t, { manifestFingerprint: "c".repeat(64) });
  assert.throws(
    () =>
      loader.resolveQualifiedLiveRuntime({
        FMCAD_LIVE_RUNTIME_ROOT: wrong.root,
      }),
    /Installed runtime bytes do not match dist\/runtime-build\.json.*no queue SDK was loaded/u,
  );
});

test("Fusion queue backend binds its client and identity to the qualified installed runtime", (t) => {
  const runtime = runtimeFixture(t);
  const project = projectFixture(t);
  setRuntimeRoot(t, runtime.root);

  const backend = new QueueScenarioBackend(
    "fusion",
    "mcp",
    new Set(),
    project.root,
    {},
    (file) => file,
  );

  assert.equal(backend.identity, `fusion:mcp:${"a".repeat(64)}`);
  assert.equal(fs.existsSync(runtime.queueClientMarker), true);
  assert.equal(fs.existsSync(project.queueClientMarker), false);
});

test("Fusion queue backend and run-live preflight reject a wrong pin before loading a queue client", async (t) => {
  const runtime = runtimeFixture(t, { manifestFingerprint: "c".repeat(64) });
  const project = projectFixture(t);
  setRuntimeRoot(t, runtime.root);

  assert.throws(
    () =>
      new QueueScenarioBackend(
        "fusion",
        "mcp",
        new Set(),
        project.root,
        {},
        (file) => file,
      ),
    /Installed runtime bytes do not match dist\/runtime-build\.json/u,
  );
  await assert.rejects(
    liveRunner.prepareBroker(),
    /Installed runtime bytes do not match dist\/runtime-build\.json/u,
  );
  await assert.rejects(
    liveRunner.captureBaseline({
      root: runtime.root,
      dist: runtime.dist,
      fingerprint: "a".repeat(64),
      queueInstancePath: path.join(runtime.dist, "src/queue-instance.js"),
    }),
    /Installed runtime bytes do not match dist\/runtime-build\.json/u,
  );
  assert.equal(fs.existsSync(runtime.queueClientMarker), false);
  assert.equal(fs.existsSync(project.queueClientMarker), false);
});

test("Fusion queue backend refuses a missing manifest before loading a queue client", (t) => {
  const runtime = runtimeFixture(t, { manifest: false });
  const project = projectFixture(t);
  setRuntimeRoot(t, runtime.root);

  assert.throws(
    () =>
      new QueueScenarioBackend(
        "fusion",
        "mcp",
        new Set(),
        project.root,
        {},
        (file) => file,
      ),
    /Runtime build manifest is missing or unreadable.*no queue SDK was loaded/u,
  );
  assert.equal(fs.existsSync(runtime.queueClientMarker), false);
  assert.equal(fs.existsSync(project.queueClientMarker), false);
});
