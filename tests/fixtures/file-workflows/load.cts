import { createHash } from "node:crypto";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import * as ts from "typescript";

interface HistoryEntry {
  file: string;
  sourcePath: string;
  sha256: string;
}

interface CompilableModule extends NodeJS.Module {
  _compile(source: string, filename: string): void;
}

function loadHistory(
  label: string,
  sourcePath: string,
  overrides: Record<string, unknown> = {},
): unknown {
  const repositoryRoot = process.cwd();
  const fixtureRoot = path.join(
    repositoryRoot,
    "tests",
    "fixtures",
    "file-workflows",
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8"),
  ) as HistoryEntry[];
  const fixture = manifest.find(
    (row) => row.file.startsWith(label + "-") && row.sourcePath === sourcePath,
  );
  if (!fixture || path.basename(fixture.file) !== fixture.file)
    throw new Error("Unregistered file workflow history");

  const historicalSource = fs
    .readFileSync(path.join(fixtureRoot, fixture.file), "utf8")
    .replace(/\r\n/gu, "\n");
  const actualHash = createHash("sha256")
    .update(historicalSource, "utf8")
    .digest("hex");
  if (actualHash !== fixture.sha256)
    throw new Error("File workflow history hash mismatch");

  const filename = path.resolve(repositoryRoot, sourcePath);
  const isolated = new Module(filename, module) as CompilableModule;
  isolated.filename = filename;
  const localRequire = Module.createRequire(filename);
  isolated.require = (id) =>
    Object.hasOwn(overrides, id) ? overrides[id] : localRequire(id);

  const source = sourcePath.endsWith(".ts")
    ? ts.transpileModule(historicalSource, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText
    : historicalSource;
  isolated._compile(source, filename);
  return isolated.exports;
}

export = loadHistory;
