import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const repository = process.cwd();
for (const scenario of [
  "missing fixture",
  "changed fixture",
  "changed compiled fixture",
  "changed test and manifest",
]) {
  test(`installed frozen qualification refuses ${scenario} before issuing a flag`, (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-frozen-corpus-"));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const runtime = path.join(base, "runtime");
    fs.cpSync(path.join(repository, "dist"), runtime, { recursive: true });
    // A package has its installed dependencies beside it, not in its fingerprint.
    fs.symlinkSync(
      path.join(repository, "node_modules"),
      path.join(base, "node_modules"),
      "dir",
    );
    const fixture = path.join(
      runtime,
      "tests/fixtures/frozen-inline-observer-evidence.json",
    );
    if (scenario === "missing fixture") fs.unlinkSync(fixture);
    else if (scenario === "changed fixture") fs.appendFileSync(fixture, " ");
    else if (scenario === "changed compiled fixture")
      fs.appendFileSync(
        path.join(runtime, "tests/fixtures/closed-scratch-artifacts.cjs"),
        " ",
      );
    else {
      const file = "tests/frozen-inline-observer.test.js";
      fs.appendFileSync(
        path.join(runtime, file),
        "\n// substituted before qualifier startup\n",
      );
      const manifestFile = path.join(
        runtime,
        "src/frozen-metadata-test-corpus.json",
      );
      const manifest: { files: Array<{ file: string; sha256: string }> } =
        JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      const entry = manifest.files.find((entry) => entry.file === file);
      assert.ok(entry);
      entry.sha256 = createHash("sha256")
        .update(fs.readFileSync(path.join(runtime, file)))
        .digest("hex");
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    }
    const output = path.join(base, "qualification");
    const result = spawnSync(
      process.execPath,
      [
        path.join(repository, "scripts/qualify-isolated-epoch.cjs"),
        "--runtime",
        runtime,
        "--output",
        output,
        "--source-commit",
        "a".repeat(40),
        "--frozen-metadata",
        "true",
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    assert.equal(result.status, 1, result.stderr || String(result.error));
    assert.match(
      result.stderr,
      scenario === "changed test and manifest"
        ? /Installed runtime differs from its staged fingerprint/
        : scenario === "missing fixture"
          ? /frozen-inline-observer-evidence\.json/
          : scenario === "changed compiled fixture"
            ? /Frozen test corpus changed: tests\/fixtures\/closed-scratch-artifacts\.cjs/
            : /Frozen test corpus changed: tests\/fixtures\/frozen-inline-observer-evidence\.json/,
    );
    assert.equal(
      fs.existsSync(path.join(output, "installed-qualification.json")),
      false,
    );
    assert.equal(
      result.stdout.trim(),
      "",
      "No checker or profile run may start for substituted evidence",
    );
  });
}
