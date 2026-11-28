import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

type Fields = Record<string, unknown>;
function record(value: unknown): Fields {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Fields;
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

/** Real isolated Git history for OFFLINE gate tests; never historical/native evidence. */
export function qualificationRepository(t: TestContext) {
  const checkout = path.resolve(__dirname, "../../..");
  const root = fs.mkdtempSync("/tmp/opencode/qualification-repository-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = "tests/native/integrated-qualification";
  fs.mkdirSync(path.join(root, directory), { recursive: true });
  for (const file of ["runner.js", "deferred_adapters.js"])
    fs.copyFileSync(
      path.join(checkout, directory, file),
      path.join(root, directory, file),
    );
  const manifest = record(
    JSON.parse(
      fs.readFileSync(path.join(checkout, directory, "manifest.json"), "utf8"),
    ) as unknown,
  );
  assert.ok(Array.isArray(manifest["features"]));
  const features = (manifest["features"] as unknown[]).map(record);
  const files: string[] = [];
  fs.mkdirSync(path.join(root, "fixture-source"));
  for (const feature of features) {
    const id = text(feature["id"]);
    assert.match(id, /^[a-z0-9-]+$/);
    const file = "fixture-source/" + id + ".txt";
    files.push(file);
    fs.writeFileSync(
      path.join(root, file),
      "OFFLINE GIT FIXTURE ONLY: " + id + "\n",
    );
    feature["files"] = [file];
    feature["entrypoint"] = file;
    if (feature["execution"] !== null && feature["execution"] !== undefined)
      record(feature["execution"])["script"] = file;
  }
  function git(args: string[]): string {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=Offline Test",
        "-c",
        "user.email=offline@example.invalid",
        ...args,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git(["init", "--initial-branch=fixture"]);
  git(["add", "."]);
  git(["commit", "-m", "Synthetic offline source ancestry"]);
  const base = git(["rev-parse", "HEAD"]);
  manifest["candidateBase"] = base;
  manifest["runnerFiles"] = [
    directory + "/runner.js",
    directory + "/deferred_adapters.js",
  ];
  for (const [index, feature] of features.entries()) {
    const file = files[index];
    assert.ok(file);
    feature["acceptedCommits"] = [base];
    feature["equivalentSourceCommits"] = [
      {
        commit: base,
        files: { [file]: git(["rev-parse", base + ":" + file]) },
      },
    ];
  }
  fs.writeFileSync(
    path.join(root, directory, "manifest.json"),
    JSON.stringify(manifest),
  );
  git(["add", "."]);
  git(["commit", "-m", "Bind synthetic offline manifest"]);
  return {
    root,
    base,
    runner: path.join(root, directory, "runner.js"),
    manifest: path.join(root, directory, "manifest.json"),
  };
}
