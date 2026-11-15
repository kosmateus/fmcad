const path = require("node:path");

const sourcePath = "^(?:src/|packages/[^/]+/src/)";

module.exports = {
  forbidden: [
    {
      name: "core-must-not-import-adapters-or-composition",
      severity: "error",
      from: { path: "^packages/core/src/" },
      to: {
        path: "^(?:packages/(?:node-adapters|control-center|opencode-adapter)/src/|src/)",
      },
    },
    {
      name: "packages-must-not-import-composition",
      severity: "error",
      from: { path: "^packages/[^/]+/src/" },
      to: { path: "^src/composition/" },
    },
    // Keep type-only edges in layer checks, but reject only emitted JS cycles.
    {
      name: "no-circular-dependencies",
      severity: "error",
      from: { path: sourcePath },
      to: {
        circular: true,
        viaOnly: { dependencyTypesNot: ["pre-compilation-only"] },
      },
    },
  ],
  options: {
    baseDir: __dirname,
    includeOnly: sourcePath,
    tsConfig: {
      fileName: path.join(__dirname, "tsconfig.dependency-cruiser.json"),
    },
    tsPreCompilationDeps: "specify",
  },
};
