import ts from "typescript";
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const runtimeRequire = createRequire(__filename);
const { stageQueueRuntime, stageQueueTestFixtures } = runtimeRequire(
  "../scripts/devtools/stage-queue-runtime.js",
) as {
  stageQueueRuntime(root: string): void;
  stageQueueTestFixtures(root: string): void;
};

test("queue staging publishes exact compiler bytes and preserves unrelated files", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "queue-emission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const compiled = path.join(root, "dist/library-build/src");
  fs.mkdirSync(compiled, { recursive: true });
  const names = [
    "queue-broker",
    "queue-client",
    "queue-closed-epoch-proof",
    "queue-isolated-epoch",
    "queue-scratch-control",
    "queue-admission",
    "queue-fixed-fixture-admission",
  ];
  for (const name of names)
    for (const extension of [".js", ".d.ts"]) {
      fs.writeFileSync(
        path.join(compiled, name + extension),
        "compiler output: " + name + extension,
      );
    }
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(compiled, "queue-broker-ports.d.ts"),
    "compiler output: broker DTO declarations",
  );
  fs.writeFileSync(path.join(root, "src/user-work.ts"), "preserve");
  stageQueueRuntime(root);
  for (const target of ["src", "dist/src"])
    for (const name of names)
      for (const extension of [".js", ".d.ts"]) {
        assert.deepEqual(
          fs.readFileSync(path.join(root, target, name + extension)),
          fs.readFileSync(path.join(compiled, name + extension)),
        );
      }
  assert.equal(
    fs.readFileSync(path.join(root, "src/user-work.ts"), "utf8"),
    "preserve",
  );
  assert.deepEqual(
    fs.readFileSync(path.join(root, "dist/src/queue-broker-ports.d.ts")),
    fs.readFileSync(path.join(compiled, "queue-broker-ports.d.ts")),
  );
});

test("missing compiler output rejects before any partial publication", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "queue-emission-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => stageQueueRuntime(root));
  assert.equal(fs.existsSync(path.join(root, "src")), false);
});

test("legacy fixture consumers receive emitted CJS from canonical CTS, not handwritten wrappers", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "queue-fixture-emission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const compiled = path.join(root, "dist/tests/fixtures");
  fs.mkdirSync(compiled, { recursive: true });
  const names = [
    "closed-scratch-artifacts.cjs",
    "closed-epoch-successor.cjs",
    "historical-module.cjs",
  ];
  for (const filename of names)
    fs.writeFileSync(
      path.join(compiled, filename),
      "compiler output: " + filename,
    );
  stageQueueTestFixtures(root);
  for (const filename of names)
    assert.deepEqual(
      fs.readFileSync(path.join(root, "tests/fixtures", filename)),
      fs.readFileSync(path.join(compiled, filename)),
    );
});

test("admission declarations resolve against the installed runtime providers", () => {
  const root = path.resolve(__dirname, "../..");
  const files = ["queue-admission", "queue-fixed-fixture-admission"].map(
    (name) => path.join(root, "dist/src", name + ".d.ts"),
  );
  for (const file of files)
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /packages\/|@fmcad\//);
  const program = ts.createProgram(files, {
    noEmit: true,
    strict: true,
    skipLibCheck: false,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ["node"],
    typeRoots: [path.join(root, "node_modules/@types")],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
});
