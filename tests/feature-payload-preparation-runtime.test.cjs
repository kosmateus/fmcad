const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  resolveQualifiedLiveRuntime,
} = require("./helpers/qualified-live-runtime.js");

function fixture(t, layout, actualFingerprint = "a".repeat(64)) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "feature-payload-runtime-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = layout === "root" ? root : path.join(root, "dist");
  fs.mkdirSync(path.join(runtime, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(runtime, "package.json"),
    JSON.stringify({ name: "fmcad", version: "0.1.0", fmcadRuntimeLayout: 1 }),
  );
  fs.writeFileSync(
    path.join(runtime, "runtime-build.json"),
    JSON.stringify({
      version: 1,
      algorithm: "sha256",
      fingerprint: "a".repeat(64),
      entrypoints: {
        "queue-worker": "src/queue-worker.js",
        "queue-autostart-worker": "src/queue-autostart-worker.js",
        "queue-broker": "src/queue-broker.js",
      },
    }),
  );
  fs.writeFileSync(
    path.join(runtime, "src/queue-instance.js"),
    `module.exports = { buildHash: () => ${JSON.stringify(actualFingerprint)} };\n`,
  );
  return { root, runtime };
}

for (const layout of ["root", "dist"]) {
  test(`qualified feature driver supports canonical ${layout} installed layout`, (t) => {
    const { root, runtime } = fixture(t, layout);
    const result = resolveQualifiedLiveRuntime({
      FMCAD_LIVE_RUNTIME_ROOT: root,
    });
    assert.equal(result.root, root);
    assert.equal(result.dist, runtime);
    assert.equal(result.manifestPath, path.join(runtime, "runtime-build.json"));
    assert.equal(
      result.queueInstancePath,
      path.join(runtime, "src/queue-instance.js"),
    );
    assert.equal(result.fingerprint, "a".repeat(64));
  });

  test(`${layout} layout still rejects mismatched runtime bytes`, (t) => {
    const { root } = fixture(t, layout, "b".repeat(64));
    assert.throws(
      () => resolveQualifiedLiveRuntime({ FMCAD_LIVE_RUNTIME_ROOT: root }),
      /Installed runtime bytes do not match/,
    );
  });

  test(`${layout} layout still rejects a symlinked identity module`, (t) => {
    const { root, runtime } = fixture(t, layout);
    const module = path.join(runtime, "src/queue-instance.js");
    fs.renameSync(module, path.join(runtime, "src/actual.js"));
    fs.symlinkSync("actual.js", module);
    assert.throws(
      () => resolveQualifiedLiveRuntime({ FMCAD_LIVE_RUNTIME_ROOT: root }),
      /Installed queue identity module is missing or unreadable/,
    );
  });

  test(`${layout} layout still rejects a malformed immutable fingerprint chain`, (t) => {
    const { root, runtime } = fixture(t, layout);
    fs.writeFileSync(
      path.join(runtime, "runtime-build.json"),
      JSON.stringify({
        version: 1,
        algorithm: "sha256",
        fingerprint: "a".repeat(64),
      }),
    );
    assert.throws(
      () => resolveQualifiedLiveRuntime({ FMCAD_LIVE_RUNTIME_ROOT: root }),
      /must be an object/,
    );
  });
}

test("an invalid root-layout marker cannot fall back to a valid dist layout", (t) => {
  const { root } = fixture(t, "dist");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "foreign", fmcadRuntimeLayout: 1 }),
  );
  assert.throws(
    () => resolveQualifiedLiveRuntime({ FMCAD_LIVE_RUNTIME_ROOT: root }),
    /does not identify an installed fmcad runtime/,
  );
});

test("a dangling root package symlink cannot fall back to a valid dist layout", (t) => {
  const { root } = fixture(t, "dist");
  fs.symlinkSync("missing-package.json", path.join(root, "package.json"));
  assert.throws(
    () => resolveQualifiedLiveRuntime({ FMCAD_LIVE_RUNTIME_ROOT: root }),
    /Installed package manifest is missing or unreadable/,
  );
});
