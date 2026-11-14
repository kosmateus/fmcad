import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
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
    const names = "publicExports" in entry ? [...entry.publicExports] : ["run"];
    write(
      file,
      "module.exports = Object.fromEntries(" +
        JSON.stringify(names) +
        ".map(name => [name, () => name]));\n" +
        ("main" in entry
          ? "module.exports[" +
            JSON.stringify(entry.main) +
            "] = () => require('node:fs').writeFileSync(__filename + '.invoked', 'main');\n"
          : ""),
    );
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
    if ("publicExports" in entry) {
      assert.ok(canonical && typeof canonical === "object");
      assert.ok(facade && typeof facade === "object");
      assert.deepEqual(
        Object.keys(facade).sort(),
        [...entry.publicExports].sort(),
      );
      for (const name of entry.publicExports)
        assert.equal(Reflect.get(facade, name), Reflect.get(canonical, name));
      if ("main" in entry) {
        assert.equal(
          Reflect.get(facade, entry.main),
          undefined,
          "Internal main is not a public API export",
        );
        const target =
          path.resolve(dir, path.dirname(entry.publicPath), entry.target) +
          ".js.invoked";
        assert.equal(fs.existsSync(target), false, "Import is inert");
        execFileSync(process.execPath, [path.join(dir, entry.publicPath)], {
          encoding: "utf8",
        });
        assert.equal(fs.readFileSync(target, "utf8"), "main");
      }
    } else assert.equal(facade, canonical);
  }
});
