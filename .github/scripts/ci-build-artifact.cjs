const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Include workspace declarations/build info, transitional runtime modules and
// fixtures as well as the installed dist runtime. Consumers must not recompile.
function buildOutputs(root) {
  const outputs = [
    "dist",
    "src/dist",
    "server.mjs",
    "docs/COMMAND_REFERENCE.md",
    "docs/COMMAND_COVERAGE.md",
    ...fs
      .readdirSync(path.join(root, "packages"))
      .map((name) => `packages/${name}/dist`),
    ...[
      "queue-broker",
      "queue-client",
      "queue-closed-epoch-proof",
      "queue-isolated-epoch",
      "queue-scratch-control",
      "queue-admission",
      "queue-fixed-fixture-admission",
      "queue-instance-liveness",
      "queue-epoch-lineage",
    ].flatMap((name) =>
      [".js", ".d.ts"].map((extension) => `src/${name}${extension}`),
    ),
    "src/queue-broker-ports.d.ts",
    ...[
      "closed-scratch-artifacts",
      "closed-epoch-successor",
      "historical-module",
    ].map((name) => `tests/fixtures/${name}.cjs`),
  ];
  for (const output of outputs) fs.lstatSync(path.join(root, output));
  return outputs;
}

function pack(root, archive) {
  // tar, unlike raw upload-artifact, retains executable bits and symlinks.
  execFileSync("tar", ["-czf", archive, "--", ...buildOutputs(root)], {
    cwd: root,
  });
}

module.exports = { buildOutputs, pack };
if (require.main === module) {
  if (process.argv.length !== 3)
    throw new Error("Usage: ci-build-artifact.cjs ARCHIVE");
  pack(path.resolve(__dirname, "../.."), path.resolve(process.argv[2]));
}
