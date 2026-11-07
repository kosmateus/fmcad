"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("installed root stages the trusted service entrypoint and verified static composition", async () => {
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
  const composition = rootComposition.createControlCenterComposition({
    port: 4748,
    installationRoot: installation,
    stateDirectory: path.join(installation, "fixture-state"),
    buildIdentity: "a".repeat(64),
    protocolVersion: 1,
    instanceNonce: "b".repeat(64),
  });
  assert.equal(composition.assets.length, 17);
  assert.ok(composition.assets.some((asset) => asset.path === "/index.html"));
  assert.ok(
    composition.assets.some(
      (asset) => asset.path === "/assets/control-center/web/index.js",
    ),
  );
  assert.throws(
    () =>
      composition.resolvePrincipal({
        id: "fixture-session",
        csrfToken: "c".repeat(64),
      }),
    { code: "PRINCIPAL_UNAVAILABLE" },
  );
  await composition.close();
});
