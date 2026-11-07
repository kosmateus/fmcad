"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

test("installed root stages the trusted service entrypoint and verified static composition", async (t) => {
  const installation = path.join(__dirname, "..", "dist");
  for (const relative of [
    "src/dist/control-center/resources/static-assets.js",
    "src/dist/control-center/server/process-main.js",
    "src/dist/control-center/server/http.js",
    "src/dist/composition/control-center.js",
    "assets/control-center/asset-manifest.json",
  ])
    assert.ok(
      fs.statSync(path.join(installation, relative)).isFile(),
      `${relative} was not emitted/staged`,
    );

  const rootComposition = require(
    path.join(installation, "src/dist/composition/control-center.js"),
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-root-read-model-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const composition = rootComposition.createControlCenterComposition(
    {
      port: 4748,
      installationRoot: installation,
      stateDirectory: path.join(installation, "fixture-state"),
      buildIdentity: "a".repeat(64),
      protocolVersion: 1,
      instanceNonce: "b".repeat(64),
    },
    {
      registry: { filePath: path.join(root, "registry", "projects.json") },
      queueDirectory: path.join(root, "queue"),
      openCodePresenceDirectory: path.join(root, "presence"),
    },
  );
  t.after(() => composition.close());
  assert.equal(composition.assets.length, 19);
  for (const module of [
    "web/agents-projects.js",
    "contracts/project-actions.js",
  ])
    assert.ok(
      composition.assets.some(
        (asset) => asset.path === `/assets/control-center/${module}`,
      ),
    );
  assert.ok(composition.assets.some((asset) => asset.path === "/index.html"));
  assert.ok(
    composition.assets.some(
      (asset) => asset.path === "/assets/control-center/web/index.js",
    ),
  );
  const principal = await composition.resolvePrincipal({
    subject: "fixture-session",
    createdAt: Date.now(),
  });
  assert.deepEqual(principal.projectIds, []);
  assert.equal(principal.globalRead, true);
  const snapshot = await composition.query.snapshot(
    { kind: "global" },
    principal,
  );
  assert.equal(snapshot.scope.kind, "global");
  assert.ok(snapshot.snapshotToken);
  assert.equal(fs.existsSync(path.join(root, "registry")), false);
  assert.equal(fs.existsSync(path.join(root, "queue")), false);
  await composition.close();
});
