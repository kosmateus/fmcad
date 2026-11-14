"use strict";
const fs = require("node:fs");
const path = require("node:path");
const [repository, registryPath, project, ready, effect, result] =
  process.argv.slice(2);
const { openProjectRegistry } = require(
  path.join(
    repository,
    "packages/node-adapters/dist/persistence/project-history/registry",
  ),
);
const { withProjectActivityFence } = require(
  path.join(
    repository,
    "packages/node-adapters/dist/persistence/project-history/activity",
  ),
);
const registry = openProjectRegistry({ filePath: registryPath });
const enter = registry.withRegistrationFence.bind(registry);
registry.withRegistrationFence = (operation) =>
  enter((snapshot) => {
    fs.writeFileSync(ready, "registry-held", { flag: "wx" });
    return operation(snapshot);
  });
try {
  withProjectActivityFence(
    project,
    () => fs.writeFileSync(effect, "admitted", { flag: "wx" }),
    { registry },
  );
  fs.writeFileSync(result, JSON.stringify({ state: "admitted" }));
} catch (error) {
  fs.writeFileSync(
    result,
    JSON.stringify({ state: "blocked", code: error.code }),
  );
}
