import { createRequire } from "node:module";
const testRoot = process.cwd();
const runtimeRequire = createRequire(testRoot + "/tests/helpers.test.js");
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const { buildRunScript } = runtimeRequire(
  "../src/run",
) as typeof import("../src/composition/run");

test("helpers cad-v1 requires exact identity and rejects unknown versions before build", () => {
  assert.throws(
    () => buildRunScript("x", [], false, "doc", {}, "v9"),
    /unknown helper version/,
  );
  assert.throws(
    () => buildRunScript("x", [], false, "doc", {}, "cad-v1"),
    /requires --doc/,
  );
  assert.throws(
    () => buildRunScript("x", [], false, "", { docId: "identity" }, "cad-v1"),
    /requires --doc/,
  );
});

test("cad-v1 run embeds the existing CAD bundle and terminal facade once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-helper-"));
  const script = path.join(dir, "input.py");
  fs.writeFileSync(
    script,
    'ARGS = []\nDOC_NAME = "fixture"\ndef run(ctx):\n    return {"passed": True}\n',
  );
  try {
    const built = buildRunScript(
      script,
      [],
      false,
      "fixture",
      { docId: "identity" },
      "cad-v1",
    );
    assert.match(built, /class CadContext/);
    assert.match(built, /class FMCAD/);
    assert.match(built, /facade\.terminal\(\)/);
    assert.ok(
      built.indexOf("_document_assert_identity") <
        built.indexOf("exec(compile"),
    );
    assert.match(
      built,
      /except BaseException as exc:[\s\S]*?facade\.terminal\(exc\)[\s\S]*?raise/,
    );
    assert.equal((built.match(/print\('FMCAD_RESULT /g) || []).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
