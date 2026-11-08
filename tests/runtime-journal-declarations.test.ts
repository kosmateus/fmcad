import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(__dirname, "../..");
for (const [group, modules] of Object.entries({
  "node-adapters/persistence": [
    "batch-journal",
    "document-save",
    "operation-journal",
    "records",
  ],
  "node-adapters/execution": [
    "invocation",
    "pause-budget",
    "request-timeout",
    "gate",
    "phased-workers",
    "sdk-probe",
    "worker",
  ],
  composition: ["cad-service", "catalog-execution", "execution-request"],
}))
  test(`staged ${group} declarations resolve without workspace package types`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-types-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const files = modules.map((name) =>
      path.join(root, "dist/src/dist", group, name + ".d.ts"),
    );
    for (const file of files) {
      assert.doesNotMatch(
        fs.readFileSync(file, "utf8"),
        /@fmcad\/core|core\/src/,
      );
    }
    const entry = path.join(directory, "consumer.cts");
    fs.writeFileSync(
      entry,
      files
        .map(
          (file, index) =>
            `import * as journal${index} from ${JSON.stringify(file.replace(/\.d\.ts$/, ".js"))};\nvoid journal${index};`,
        )
        .join("\n"),
    );
    const program = ts.createProgram([entry], {
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
