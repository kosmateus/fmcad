"use strict";
// Development-only comparison. Both engines must already be installed; this
// script performs no downloads, installation, Python execution or SDK calls.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

const pyright = process.argv[2];
if (!pyright) throw new Error("Pass the preinstalled Pyright index.js path");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-comparison-"));
try {
  const fixtures = path.resolve(__dirname, "../tests/fixtures/python-checker");
  fs.cpSync(fixtures, directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "adsk/__init__.py"), "");
  fs.writeFileSync(
    path.join(directory, "pyrightconfig.json"),
    JSON.stringify({
      include: ["errors.py", "unknown.py"],
      typeCheckingMode: "strict",
      pythonVersion: "3.11",
      reportUnusedImport: "none",
    }),
  );
  for (const engine of [
    require.resolve("basedpyright/index.js"),
    path.resolve(pyright),
  ]) {
    const start = performance.now();
    const output = spawnSync(
      process.execPath,
      [
        engine,
        "--outputjson",
        "--pythonpath",
        path.join(directory, "no-host-python"),
        "--project",
        path.join(directory, "pyrightconfig.json"),
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { PATH: process.env["PATH"], HOME: directory },
      },
    );
    if (output.error || output.status !== 1)
      throw new Error(JSON.stringify(output));
    const result = record(JSON.parse(output.stdout));
    const diagnostics = result["generalDiagnostics"];
    assert.ok(Array.isArray(diagnostics));
    console.log(
      JSON.stringify(
        {
          engine: engine.includes("basedpyright") ? "basedpyright" : "pyright",
          version: text(result["version"]),
          exit: output.status,
          elapsedMs: Math.round(performance.now() - start),
          diagnostics: diagnostics.map((value: unknown) => {
            const diagnostic = record(value);
            const line = record(record(diagnostic["range"])["start"])["line"];
            assert.ok(typeof line === "number");
            const rule = diagnostic["rule"];
            assert.ok(rule === undefined || typeof rule === "string");
            return {
              file: path.basename(text(diagnostic["file"])),
              line: line + 1,
              rule,
              severity: text(diagnostic["severity"]),
            };
          }),
        },
        null,
        2,
      ),
    );
  }
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
