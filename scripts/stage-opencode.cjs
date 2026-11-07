"use strict";
// Isolated staging: no ownership of CLI/MCP outputs or other build steps.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const built = path.join(root, "dist/opencode-build");
// V2 configured directory loading probes <directory>/server or index rather
// than resolving package exports. This generated ESM facade shares the object.
fs.writeFileSync(
  path.join(root, "server.mjs"),
  'export { default } from "./dist/src/dist/entrypoints/opencode.mjs";\n',
);
function stage(source, target, replacements) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name),
      to = path.join(target, entry.name);
    if (entry.isDirectory()) stage(from, to, replacements);
    else if (/\.(?:js|mjs|d\.ts|d\.mts)$/.test(entry.name)) {
      let content = fs.readFileSync(from, "utf8");
      for (const [a, b] of replacements) content = content.replaceAll(a, b);
      fs.writeFileSync(to, content);
    }
  }
}
for (const destination of ["src/dist", "dist/src/dist"]) {
  const base = path.join(root, destination);
  stage(
    path.join(built, "packages/opencode-adapter/src"),
    path.join(base, "opencode-adapter"),
    [
      ["@fmcad/core", "../../core"],
      ["../../../../src/api/contracts", "../../api/contracts"],
    ],
  );
  stage(path.join(built, "src/entrypoints"), path.join(base, "entrypoints"), [
    ["../../packages/opencode-adapter/src/", "../opencode-adapter/"],
  ]);
  const target = path.join(base, "composition/opencode.js");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    fs
      .readFileSync(path.join(built, "src/composition/opencode.js"), "utf8")
      .replaceAll('require("../config")', 'require("../../config")')
      .replaceAll(
        'require("../opencode/presence.cjs")',
        'require("../../opencode/presence.cjs")',
      ),
  );
}
