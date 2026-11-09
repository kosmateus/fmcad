import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
const root = path.resolve(__dirname, "../../..");
const load = createRequire(path.join(root, "package.json"));
const { stageCompatibility } = load(
  "./dist/scripts/devtools/stage-compatibility.js",
) as typeof import("../../dist/scripts/devtools/stage-compatibility");
const { compatibilityModules } = load(
  "./dist/scripts/devtools/compatibility-modules.js",
) as typeof import("../../dist/scripts/devtools/compatibility-modules");
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
test("missing canonical output leaves every existing compatibility entry untouched", (t) => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "fmcad-compatibility-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missing = compatibilityModules.at(-1)!;
  for (const entry of compatibilityModules) {
    if (entry !== missing)
      write(path.join(dir, entry.emittedPath), "module.exports = {};\n");
    write(path.join(dir, entry.publicPath), "preserved previous build\n");
  }
  assert.throws(() => stageCompatibility(dir));
  for (const entry of compatibilityModules)
    assert.equal(
      fs.readFileSync(path.join(dir, entry.publicPath), "utf8"),
      "preserved previous build\n",
    );
});
test("clean and incremental compatibility staging preserve canonical export identity", (t) => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "fmcad-compatibility-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const entry of compatibilityModules) {
    write(path.join(dir, entry.emittedPath), "compiled target\n");
    const target = path.resolve(
      dir,
      path.dirname(entry.publicPath),
      entry.target,
    );
    const file = target.endsWith(".js") ? target : target + ".js";
    write(file, "module.exports = { run() { return 'canonical'; } };\n");
  }
  stageCompatibility(dir);
  write(
    path.join(dir, compatibilityModules[0].publicPath),
    "throw new Error('stale handwritten copy');\n",
  );
  stageCompatibility(dir);
  const requireFixture = createRequire(path.join(dir, "package.json"));
  for (const entry of compatibilityModules) {
    const canonical: unknown = requireFixture(
      path.resolve(dir, path.dirname(entry.publicPath), entry.target),
    );
    const facade: unknown = requireFixture(path.join(dir, entry.publicPath));
    assert.equal(facade, canonical);
  }
});
