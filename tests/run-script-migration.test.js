"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const current = require("../src/run");
const previous = require("./fixtures/historical-module.cjs")(
  "d496c734d63661f2f131b6797ce171e9373a58f4",
  "src/run.js",
);

function fixture(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "run migration żółć "),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source.py");
  const source =
    'ARGS = []\nDOC_NAME = ""\ndef run(context):\n    return ARGS\n';
  fs.writeFileSync(file, source);
  return { directory, file, source };
}

for (const [label, identity, helper, operations] of [
  ["plain", {}, undefined, []],
  ["creation ID", { docId: "creation-A" }, undefined, []],
  ["file ID", { docFileId: "urn:file:A" }, undefined, []],
  [
    "read-only",
    { docId: "creation-A", docFileId: "urn:file:A", readOnly: true },
    undefined,
    [],
  ],
  ["helpers", { docId: "creation-A" }, "cad-v1", []],
  [
    "read-only helpers",
    { docFileId: "urn:file:A", readOnly: true },
    "cad-v1",
    ["body.list"],
  ],
]) {
  test(`run migration preserves complete ${label} artifacts and raw provenance`, (t) => {
    const f = fixture(t);
    const args = [
      f.file,
      { text: "Zażółć 🧪 $&", yes: true, value: null },
      true,
      "Model A",
      identity,
      helper,
      operations,
      { trustedStageContext: { runId: "stage-A" } },
    ];
    const before = {},
      after = {};
    const context = require("../src/invocation").context;
    const historical = context.run(before, () =>
      previous.prepareRunScript(...args),
    );
    const migrated = context.run(after, () =>
      current.prepareRunScript(...args),
    );
    assert.deepEqual(migrated, historical);
    assert.deepEqual(after, before);
    assert.deepEqual(after, {
      sourcePath: f.file,
      sourceHash: createHash("sha256").update(f.source).digest("hex"),
    });
    assert.equal(current.buildRunScript(...args), historical.script);
    assert.equal(fs.readFileSync(f.file, "utf8"), f.source);
  });
}

test("script search, listing, validation and missing-slot failures retain their contract", (t) => {
  const f = fixture(t);
  const config = path.join(f.directory, "config.json");
  const scripts = path.join(f.directory, "scripts");
  fs.mkdirSync(scripts);
  fs.writeFileSync(path.join(scripts, "box.py"), f.source);
  fs.writeFileSync(path.join(scripts, "z.py"), "# user script\n");
  fs.writeFileSync(path.join(scripts, "ignored.txt"), "not Python");
  for (const api of [previous, current]) {
    assert.equal(
      api.resolveScript("box", { config }),
      path.join(scripts, "box.py"),
    );
    assert.equal(api.resolveScript(f.file), f.file);
    assert.equal(
      api.listScripts({ config }).filter((item) => item.name === "box").length,
      2,
    );
  }
  assert.deepEqual(
    current.listScripts({ config }),
    previous.listScripts({ config }),
  );
  for (const name of [
    "nonexistent-script-93848",
    path.join(f.directory, "missing.py"),
  ]) {
    let expected;
    try {
      previous.resolveScript(name, { config });
    } catch (error) {
      expected = error.message;
    }
    assert.throws(() => current.resolveScript(name, { config }), {
      message: expected,
    });
  }
  for (const args of [
    [f.file, [], false, undefined, { docId: "id" }],
    [f.file, [], false, "Model", {}, "unknown"],
    [f.file, [], false, "Model", {}, "cad-v1"],
  ]) {
    let expected;
    try {
      previous.prepareRunScript(...args);
    } catch (error) {
      expected = error.message;
    }
    assert.equal(typeof expected, "string");
    assert.throws(() => current.prepareRunScript(...args), {
      message: expected,
    });
  }
  fs.writeFileSync(f.file, 'print("no injection slots")\n');
  for (const args of [
    [f.file, [], true],
    [f.file, [], false, "Model"],
  ]) {
    let expected;
    try {
      previous.prepareRunScript(...args);
    } catch (error) {
      expected = error.message;
    }
    assert.throws(() => current.prepareRunScript(...args), {
      message: expected,
    });
  }
});

test("both versions reject changed or unpinned queued source before preparing an artifact", (t) => {
  const f = fixture(t);
  const keys = ["FMCAD_QUEUE_WORKER_JOB", "FMCAD_QUEUE_INPUT_FILES"];
  const original = keys.map((key) => process.env[key]);
  t.after(() =>
    keys.forEach((key, index) => {
      if (original[index] === undefined) delete process.env[key];
      else process.env[key] = original[index];
    }),
  );
  process.env.FMCAD_QUEUE_WORKER_JOB = "run-migration";
  const pin = [
    {
      path: f.file,
      sha256: createHash("sha256").update(f.source).digest("hex"),
    },
  ];
  for (const api of [previous, current]) {
    process.env.FMCAD_QUEUE_INPUT_FILES = JSON.stringify(pin);
    fs.writeFileSync(f.file, f.source);
    assert.equal(api.prepareRunScript(f.file, [], false).script, f.source);
    fs.writeFileSync(f.file, f.source + "# changed after queue acceptance\n");
    assert.throws(() => api.prepareRunScript(f.file, [], false), {
      code: "INPUT_CHANGED",
    });
    fs.writeFileSync(f.file, f.source);
    process.env.FMCAD_QUEUE_INPUT_FILES = "[]";
    assert.throws(() => api.prepareRunScript(f.file, [], false), {
      code: "INPUT_CHANGED",
    });
  }
});

test("source verification and preparation use the same read even if the file changes", (t) => {
  const f = fixture(t);
  let observed, verified;
  const api = require("../src/dist/python/run-script").createRunScriptAdapter({
    observeSource(filename, bytes) {
      assert.equal(filename, f.file);
      observed = bytes;
      fs.writeFileSync(filename, 'raise RuntimeError("replacement")\n');
    },
    verifySource(filename, bytes) {
      assert.equal(filename, f.file);
      assert.equal(bytes, observed);
      verified = bytes.toString("utf8");
    },
  });
  const artifact = api.prepareRunScript(f.file, [], false);
  assert.equal(verified, f.source);
  assert.equal(artifact.script, f.source);
  assert.match(fs.readFileSync(f.file, "utf8"), /replacement/);
});
