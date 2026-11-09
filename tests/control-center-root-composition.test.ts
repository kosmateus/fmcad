import { createRequire } from "node:module";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const load = createRequire(
  path.join(process.cwd(), "tests/control-center-root-composition.test.js"),
);

test("installed root stages the trusted service entrypoint and verified static composition", async (t) => {
  const installation = path.join(process.cwd(), "dist");
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

  const rootComposition = load(
    path.join(installation, "src/dist/composition/control-center.js"),
  ) as typeof import("../src/composition/control-center");
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
  t.after(() => composition.close?.());
  assert.ok(composition.assets);
  assert.equal(composition.assets.length, 33);
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
  assert.ok("scope" in snapshot);
  assert.equal(snapshot.scope.kind, "global");
  assert.ok(snapshot.snapshotToken);
  assert.equal(fs.existsSync(path.join(root, "registry")), false);
  assert.equal(fs.existsSync(path.join(root, "queue")), false);
  await composition.close?.();
});
