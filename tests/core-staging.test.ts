import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const runtimeRequire = createRequire(__filename);
const { stageCore } = runtimeRequire("../scripts/devtools/stage-core.js") as {
  stageCore(root: string, identityOnly?: boolean): void;
};

function write(
  root: string,
  file: string,
  content = "module.exports = {};\n",
): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

const workspaces = [
  ["packages/core", "application/cad", "core/application/cad"],
  ...[
    "console",
    "persistence",
    "config-platform",
    "fusion-transport",
    "telemetry",
    "python",
    "review",
    "execution",
    "broker-ipc",
    "control-center",
  ].map((name) => [
    "packages/node-adapters",
    name,
    ["config-platform", "fusion-transport", "python", "review"].includes(name)
      ? name
      : `node-adapters/${name}`,
  ]),
  ...["contracts", "resources", "server"].map((name) => [
    "packages/control-center",
    name,
    `control-center/${name}`,
  ]),
] as const;
const scopes = [
  ...workspaces.map(([workspace, scope, target]) => ({
    source: `${workspace}/src/${scope}`,
    compiled: `${workspace}/dist/${scope}`,
    target: `src/dist/${target}`,
  })),
  ...["api", "composition", "entrypoints", "entrypoints/cli"].map((name) => ({
    source: `src/${name}`,
    compiled: `dist/library-build/src/${name}`,
    target: `src/dist/${name}`,
  })),
];
const extensions = [".js", ".js.map", ".d.ts", ".d.ts.map"];

function fixture(root: string): void {
  for (const scope of scopes) {
    write(root, `${scope.source}/old-report.ts`, "export {};\n");
    for (const extension of extensions)
      write(root, `${scope.compiled}/old-report${extension}`);
  }
  write(
    root,
    "packages/node-adapters/src/config-platform/runtime-paths.ts",
    "export {};\n",
  );
  write(
    root,
    "packages/node-adapters/dist/config-platform/runtime-paths.js",
    `
    exports.resolveRuntimePaths = () => ({ installation: ${JSON.stringify(path.join(root, "dist"))} });
    exports.runtimeBuildIdentity = () => 'fixture-identity';
    exports.resolveChildEntrypoint = (paths, name) => require('node:path').join(paths.installation, 'src', name + '.js');
  `,
  );
  write(
    root,
    "package.json",
    JSON.stringify({
      name: "fmcad-staging-fixture",
      version: "1.0.0",
      engines: { node: ">=22" },
      files: ["dist/src"],
    }),
  );
  for (const file of [
    "assets/fixture.py",
    "runtime/python/fixture.py",
    "scripts/console-source-format.py",
    "scripts/console-source-requirements.txt",
  ])
    write(root, file, "preserve\n");
  for (const name of ["fmcad.js", "fmcad-mcp.js"]) {
    write(root, `bin/${name}`, "// stale launcher\n");
    write(root, `dist/launchers/${name}`, "#!/usr/bin/env node\r\n");
  }
}

test("incremental staging removes renamed modules from compiler output and both runtime copies", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "core-staging-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixture(root);
  stageCore(root);
  for (const scope of scopes) {
    assert.ok(fs.existsSync(path.join(root, scope.target, "old-report.js")));
    fs.renameSync(
      path.join(root, scope.source, "old-report.ts"),
      path.join(root, scope.source, "summary.ts"),
    );
    for (const extension of extensions) {
      write(root, `${scope.compiled}/summary${extension}`);
      // Include stale files which no longer exist even in compiler output.
      write(root, `${scope.target}/removed${extension}`);
      write(root, `dist/${scope.target}/removed${extension}`);
    }
  }
  const preserved = [
    "dist/runtime/python/typing/current.json",
    "dist/unrelated.js",
    "src/dist/entrypoints/opencode.mjs",
    "src/dist/entrypoints/opencode.d.mts",
    "dist/src/dist/entrypoints/opencode.mjs",
    "dist/src/dist/entrypoints/opencode.d.mts",
  ];
  for (const file of preserved) write(root, file, "preserve\n");
  const retired = [
    "console-app.js",
    "console-source-view.js",
    "console-tabs/tasks.js",
  ];
  for (const file of retired) {
    // A stale source overlay must not restore an explicitly retired runtime.
    write(root, `src/${file}`, "// retired terminal renderer\n");
    for (const destination of ["src/dist", "dist/src", "dist/src/dist"])
      write(root, `${destination}/${file}`, "// stale staged renderer\n");
  }
  write(root, "src/console-source.js", "// retained domain reader\n");
  stageCore(root);
  stageCore(root); // Repeating staging must not restore the orphan outputs.
  for (const scope of scopes)
    for (const output of [
      scope.compiled,
      scope.target,
      `dist/${scope.target}`,
    ]) {
      assert.equal(
        fs.readFileSync(path.join(root, output, "summary.js"), "utf8"),
        "module.exports = {};\n",
      );
      assert.ok(fs.existsSync(path.join(root, output, "summary.d.ts")));
      for (const extension of extensions)
        for (const name of ["old-report", "removed"])
          assert.equal(
            fs.existsSync(path.join(root, output, name + extension)),
            false,
            `${output}/${name}${extension}`,
          );
    }
  for (const file of preserved)
    assert.equal(fs.readFileSync(path.join(root, file), "utf8"), "preserve\n");
  for (const file of retired)
    for (const destination of ["src/dist", "dist/src", "dist/src/dist"])
      assert.equal(fs.existsSync(path.join(root, destination, file)), false);
  assert.equal(
    fs.readFileSync(path.join(root, "dist/src/console-source.js"), "utf8"),
    "// retained domain reader\n",
  );
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }),
  ) as Array<{ files: Array<{ path: string }> }>;
  const paths = packed.flatMap((item) => item.files.map((file) => file.path));
  assert.ok(paths.includes("dist/src/dist/core/application/cad/summary.js"));
  assert.deepEqual(
    paths.filter((file) =>
      /old-report|removed|console-app\.js|console-source-view\.js|console-tabs\/tasks\.js/.test(
        file,
      ),
    ),
    [],
  );
});

test("missing staging input rejects before pruning existing outputs", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "core-staging-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fixture(root);
  fs.rmSync(path.join(root, "src/api"), { recursive: true });
  const stale = "packages/core/dist/orphan.js";
  write(root, stale);
  assert.throws(() => stageCore(root), /ENOENT|Missing staging input/);
  assert.ok(fs.existsSync(path.join(root, stale)));
  assert.equal(fs.existsSync(path.join(root, "src/dist")), false);
});
