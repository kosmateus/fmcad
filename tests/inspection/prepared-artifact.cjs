"use strict";
// Keep the test harness on the same pure CAD planner/shared manifest/bundler
// path as src/cad.js while allowing it to read a separate, clean source tree.
const path = require("node:path");
const { createRequire } = require("node:module");
const repositoryRoot = path.resolve(__dirname, "../..");
const load = createRequire(__filename);
const { pythonLiteral, prepareCadBundle, verifyPythonArtifact } =
  load("../../src/python");
const { planCadScript } = load("../../src/dist/core/application/cad/prepare");
const { planInspection } = load("../../src/dist/core/application/inspection");
const { catalog, contracts, validateCad } = load("../../src/catalog");

function prepare(operation, data, context, sourceRoot = repositoryRoot) {
  const entry = validateCad(operation, data);
  if (operation === "inspect.pack")
    data = planInspection(data, contracts, validateCad);
  const plan = planCadScript(operation, data, context, entry, pythonLiteral);
  const artifact = prepareCadBundle(
    sourceRoot,
    plan.wrapper,
    { request: plan.request, context: plan.context },
    plan.profile,
  );
  verifyPythonArtifact(artifact);
  return { artifact, entry: catalog[operation] };
}

module.exports = { prepare, repositoryRoot };
