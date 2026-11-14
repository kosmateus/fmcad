import fs from "node:fs";
import path from "node:path";
import Module, { createRequire } from "node:module";
const load = createRequire(__filename);
import { createHash } from "node:crypto";

interface Fixture {
  revision: string;
  sourcePath: string;
  file: string;
  sha256: string;
}

// Frozen source comparisons must work in a clean/shallow GitHub checkout.
// The originals are data, not a second production implementation.
function historicalModule(
  revision: string,
  sourcePath: string,
  runtimePath = sourcePath,
): unknown {
  const emitted = __dirname.endsWith(path.join("dist", "tests", "fixtures"));
  const root = path.resolve(__dirname, emitted ? "../../.." : "../..");
  const directory = path.join(root, "tests", "fixtures", "history");
  const manifest: Fixture[] = JSON.parse(
    fs.readFileSync(path.join(directory, "manifest.json"), "utf8"),
  );
  const fixture = manifest.find(
    (entry) => entry.revision === revision && entry.sourcePath === sourcePath,
  );
  if (!fixture || path.basename(fixture.file) !== fixture.file)
    throw new Error(
      "Unregistered historical source: " + revision + ":" + sourcePath,
    );
  const bytes = fs.readFileSync(path.join(directory, fixture.file));
  if (createHash("sha256").update(bytes).digest("hex") !== fixture.sha256)
    throw new Error("Historical source hash mismatch: " + fixture.file);
  let source = bytes.toString("utf8");
  if (sourcePath.endsWith(".ts")) {
    const ts = load("typescript") as typeof import("typescript");
    source = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText;
  }
  const filename = path.resolve(root, runtimePath);
  if (!filename.startsWith(root + path.sep))
    throw new Error("Historical runtime path escapes checkout");
  const isolated = new Module(filename, module) as Module & {
    _compile(source: string, filename: string): void;
  };
  isolated.filename = filename;
  isolated.paths =
    Module.createRequire(filename).resolve.paths("fixture") ?? [];
  isolated._compile(source, filename);
  return isolated.exports as unknown;
}
export = historicalModule;
