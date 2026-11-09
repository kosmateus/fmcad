import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const stage = path.resolve(__dirname, "../..");
const load = createRequire(path.join(stage, "package.json"));
const { RUNTIME_FILES, TEST_FILES, candidateFiles, archiveFiles, install } =
  load(
    path.join(
      process.env["FMCAD_UPSTREAM_TEST_ROOT"] || stage,
      "scripts/install-queue-phases",
    ),
  ) as typeof import("../scripts/devtools/install-queue-phases");
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
const hash = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qinstall-"));
  const dir = path.join(root, "queue");
  fs.mkdirSync(dir);
  const entries = new Map([
    [
      "package.json",
      Buffer.from('{"name":"offline-install-fixture","version":"1.0.0"}'),
    ],
  ]);
  for (const file of RUNTIME_FILES)
    if (file !== "src/queue-phased.js")
      entries.set(
        file,
        Buffer.from("original fixture bytes for " + file + "\n"),
      );
  const records: Buffer[] = [];
  for (const [file, bytes] of entries) {
    const header = Buffer.alloc(512);
    header.write("package/" + file, 0);
    header.write("0000644\0", 100);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header[156] = 48;
    header.write("ustar\0", 257);
    header.fill(32, 148, 156);
    header.write(
      [...header]
        .reduce((sum, value) => sum + value, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
    );
    records.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  const archive = path.join(root, "baseline.tgz");
  fs.writeFileSync(
    archive,
    zlib.gzipSync(Buffer.concat([...records, Buffer.alloc(1024)])),
  );
  const baseline = archiveFiles(archive);
  fs.mkdirSync(path.join(root, "bin"));
  const packageBytes = baseline.get("package.json");
  assert.ok(packageBytes);
  fs.writeFileSync(path.join(root, "package.json"), packageBytes);
  for (const file of RUNTIME_FILES) {
    const original = baseline.get(file);
    if (!original) continue;
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), original);
  }
  fs.writeFileSync(
    path.join(root, "src/console-theme.js"),
    "unrelated user UI work\n",
  );
  fs.writeFileSync(
    path.join(dir, "queue-state.json"),
    JSON.stringify({ active: null, blocked: null, lease: null, jobs: {} }),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir, stage, archive };
}

function stagedFixture(root: string): string {
  const stage = path.join(root, "candidate");
  for (const file of [...RUNTIME_FILES, ...TEST_FILES]) {
    const target = path.join(stage, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "// compiled fixture: " + file + "\n");
  }
  return stage;
}

test("the candidate manifest retains compiled dependencies and fixtures without unrelated state", (t) => {
  const f = fixture(t),
    candidate = stagedFixture(f.root);
  const entries = [
    "src/dist/node-adapters/execution/phased-workers.js",
    "dist/runtime/python/typing/checker-project.py",
    "dist/scripts/devtools/runtime.js",
    "tests/fixtures/receipt.json",
    "dist/tests/fixtures/typed-fixture.cjs",
  ];
  for (const file of [
    ...entries,
    ".cad/private.json",
    "node_modules/private.js",
    "src/unrelated-user.js",
    "tests/uncompiled.test.ts",
  ]) {
    const target = path.join(candidate, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "fixture");
  }
  const manifest = candidateFiles(candidate);
  assert.deepEqual(candidateFiles(candidate), manifest);
  const files = [...manifest.runtime, ...manifest.tests];
  for (const file of entries) assert.ok(files.includes(file), file);
  for (const file of [
    ".cad/private.json",
    "node_modules/private.js",
    "src/unrelated-user.js",
    "tests/uncompiled.test.ts",
  ])
    assert.equal(files.includes(file), false, file);
  fs.symlinkSync(
    path.join(candidate, ".cad/private.json"),
    path.join(candidate, "src/dist/escaped.json"),
  );
  assert.throws(() => candidateFiles(candidate), { code: "INVALID_STAGE" });
});

test("changed staged bytes refuse publication and restore already applied files", async (t) => {
  const f = fixture(t),
    candidate = stagedFixture(f.root);
  const before = Object.fromEntries(
    RUNTIME_FILES.filter((file) => fs.existsSync(path.join(f.root, file))).map(
      (file) => [file, hash(path.join(f.root, file))],
    ),
  );
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = function (from, to) {
    const result = rename.call(this, from, to);
    if (
      !injected &&
      String(from).endsWith(".install") &&
      String(to).startsWith(path.join(f.root, "assets"))
    ) {
      injected = true;
      fs.appendFileSync(
        path.join(candidate, "src/i18n.js"),
        "// later stage mutation\n",
      );
    }
    return result;
  };
  try {
    await assert.rejects(
      install({
        ...f,
        stage: candidate,
        apply: true,
        control: async () => assert.fail("No broker exists"),
      }),
      { code: "CONCURRENT_SOURCE_CHANGE" },
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(injected, true);
  for (const [file, digest] of Object.entries(before))
    assert.equal(hash(path.join(f.root, file)), digest);
  assert.equal(fs.existsSync(path.join(f.root, "src/queue-phased.js")), false);
  assert.equal(fs.existsSync(path.join(f.dir, "recovery.lock")), false);
});

test("installation refuses a foreign active/unknown lease without stopping or editing anything", async (t) => {
  const f = fixture(t),
    before = hash(path.join(f.root, "src/queue-state.js"));
  let stops = 0;
  fs.writeFileSync(path.join(f.dir, "broker.lock"), "{}");
  await assert.rejects(
    install({
      ...f,
      apply: true,
      control: async (action) => {
        if (action === "stop") stops++;
        return {
          active: "other",
          blocked: { id: "other" },
          lease: { clientId: "other-owner" },
          jobs: {},
        };
      },
    }),
    { code: "QUEUE_NOT_QUIESCENT" },
  );
  assert.equal(stops, 0);
  assert.equal(hash(path.join(f.root, "src/queue-state.js")), before);
  assert.equal(fs.existsSync(path.join(f.dir, "recovery.lock")), false);
});

test("concurrent installed-source changes are preserved, never overwritten by the staged patch", async (t) => {
  const f = fixture(t);
  fs.appendFileSync(
    path.join(f.root, "src/queue-state.js"),
    "\n// another author\n",
  );
  const before = hash(path.join(f.root, "src/queue-state.js"));
  await assert.rejects(
    install({
      ...f,
      apply: true,
      control: async () => {
        throw Error("Control must not be called");
      },
    }),
    { code: "CONCURRENT_SOURCE_CHANGE" },
  );
  assert.equal(hash(path.join(f.root, "src/queue-state.js")), before);
});

test("quiescent installation fences autostart, stops only the idle broker and preserves unrelated files", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "broker.lock"), "{}");
  const calls: string[] = [];
  const result = await install({
    ...f,
    apply: true,
    control: async (action) => {
      calls.push(action);
      if (action === "stop") {
        assert.equal(fs.existsSync(path.join(f.dir, "recovery.lock")), true);
        fs.unlinkSync(path.join(f.dir, "broker.lock"));
        return { stopping: true };
      }
      return { active: null, blocked: null, lease: null, jobs: {} };
    },
  });
  assert.equal(result["state"], "installed");
  assert.equal(result["fusionCalls"], 0);
  assert.equal(result["brokerLeftStopped"], true);
  assert.deepEqual(calls, ["status", "status", "stop"]);
  assert.equal(fs.existsSync(path.join(f.dir, "recovery.lock")), false);
  assert.equal(
    fs.readFileSync(path.join(f.root, "src/console-theme.js"), "utf8"),
    "unrelated user UI work\n",
  );
  assert.ok(Array.isArray(result["files"]));
  for (const value of result["files"] as unknown[]) {
    const file = record(value);
    assert.equal(
      hash(path.join(f.root, text(file["name"]))),
      file["afterSha256"],
    );
  }
  assert.equal(
    fs.existsSync(path.join(text(result["backup"]), "manifest.json")),
    true,
  );
});

test("an interrupted local installation restores only its own bytes and removes incomplete temporary files", async (t) => {
  const f = fixture(t);
  const before = Object.fromEntries(
    RUNTIME_FILES.filter((file) => fs.existsSync(path.join(f.root, file))).map(
      (file) => [file, hash(path.join(f.root, file))],
    ),
  );
  const rename = fs.renameSync;
  let installed = 0,
    injected = false;
  fs.renameSync = function (from, to) {
    if (
      String(from).endsWith(".install") &&
      String(to).startsWith(f.root) &&
      !String(to).includes("/tmp/queue-phases-install-")
    ) {
      installed++;
      if (installed === 2 && !injected) {
        injected = true;
        throw Object.assign(new Error("Controlled install interruption"), {
          code: "EIO",
        });
      }
    }
    return rename.call(this, from, to);
  };
  try {
    await assert.rejects(
      install({
        ...f,
        apply: true,
        control: async () => {
          throw Error("No broker is running");
        },
      }),
      { code: "EIO" },
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(injected, true);
  for (const [file, value] of Object.entries(before))
    assert.equal(hash(path.join(f.root, file)), value);
  assert.equal(fs.existsSync(path.join(f.dir, "recovery.lock")), false);
  assert.equal(
    fs
      .readdirSync(path.join(f.root, "assets/cad"))
      .some((file) => file.endsWith(".install")),
    false,
  );
});
