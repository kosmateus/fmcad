const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const {
  cadBundleManifest,
  cadBundleUnits,
  orderBundle,
} = require("../packages/node-adapters/dist/python/bundle");
const {
  preparePythonArtifact,
} = require("../packages/node-adapters/dist/python/artifact");
const {
  nativeDriveBundleManifest,
  nativeDriveHandlers,
  withNativeDrive,
} = require("../packages/node-adapters/dist/python/native-drive-manifest");

const root = path.resolve(__dirname, "..");
const withoutNativeDrive = cadBundleManifest.filter(
  (unit) => !unit.id.startsWith("native-drive-"),
);

test("canonical native-drive manifest includes prerequisites once and preserves the light profile", () => {
  const units = cadBundleUnits(root, "full", cadBundleManifest);
  const family = units.filter((unit) => unit.id.startsWith("native-drive-"));
  assert.deepEqual(
    family.map((unit) => unit.id),
    nativeDriveBundleManifest.map((unit) => unit.id),
  );
  for (const dependency of ["core", "assembly"]) {
    assert.ok(
      units.findIndex((unit) => unit.id === dependency) <
        units.findIndex((unit) => unit.id === "native-drive-fusion"),
    );
  }
  assert.deepEqual(
    cadBundleUnits(root, "document-status", cadBundleManifest),
    cadBundleUnits(root, "document-status"),
  );
  assert.ok(
    cadBundleManifest.some((unit) => unit.id === "native-drive-handlers"),
  );
  const appended = withNativeDrive(withoutNativeDrive);
  assert.deepEqual(
    appended.slice(-nativeDriveBundleManifest.length).map((unit) => unit.id),
    nativeDriveBundleManifest.map((unit) => unit.id),
  );
  assert.throws(() => withNativeDrive(cadBundleManifest), /already present/);
  assert.throws(
    () =>
      orderBundle(
        [...cadBundleManifest, ...nativeDriveBundleManifest],
        ["native-drive-handlers"],
      ),
    /duplicate/,
  );
  assert.throws(
    () => orderBundle(nativeDriveBundleManifest, ["native-drive-handlers"]),
    /Incomplete.*core/,
  );
  for (const item of nativeDriveBundleManifest) {
    assert.ok(Object.isFrozen(item));
    assert.ok(Object.isFrozen(item.dependencies));
  }
});

test("prepared artifact dispatches driver and MotionLink handlers without checkout reads", () => {
  const units = cadBundleUnits(root, "full");
  const artifact = preparePythonArtifact(units);
  const baseline = preparePythonArtifact(
    cadBundleUnits(root, "full", withoutNativeDrive),
  );
  assert.equal(
    artifact.script,
    units.map((unit) => unit.source).join("\n\n"),
  );
  assert.notEqual(artifact.sha256, baseline.sha256);
  const runner = fs.readFileSync(
    path.join(__dirname, "fixtures/native-drive-prepared-artifact.py"),
    "utf8",
  );
  const result = spawnSync("python3", ["-B", "-c", runner], {
    input: JSON.stringify({
      baseline: baseline.script,
      artifact: artifact.script,
      handlers: nativeDriveHandlers,
    }),
    encoding: "utf8",
    cwd: "/tmp",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(Number(result.stdout.trim()) > 250);
});
