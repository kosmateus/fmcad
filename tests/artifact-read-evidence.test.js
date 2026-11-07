"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const current = require("../src/dist/node-adapters/persistence/records");
const previous = require("./fixtures/historical-module.cjs")(
  "04fa9e1fd0dab98ea7a8c49f3a26fe46658f07f6",
  "packages/node-adapters/src/persistence/records.ts",
);
const {
  createArtifactStore,
} = require("../src/dist/node-adapters/persistence/artifact-store");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "record.json");
  fs.writeFileSync(file, '{"retained":true}');
  return { root, file };
}

for (const code of ["ENOENT", "EACCES", "EIO"]) {
  test(`an opened file with unavailable path evidence (${code}) is not absent`, (t) => {
    const { file } = fixture(t);
    const cause = Object.assign(new Error("injected path evidence failure"), {
      code,
    });
    for (const [api, expected] of [
      [previous, code],
      [current, "STORAGE_UNAVAILABLE"],
    ]) {
      let reads = 0,
        closes = 0;
      const io = {
        ...fs,
        realpathSync(value) {
          assert.match(value, /^\/proc\/self\/fd\/\d+$/);
          throw cause;
        },
        readSync(...args) {
          reads++;
          return fs.readSync(...args);
        },
        closeSync(fd) {
          closes++;
          return fs.closeSync(fd);
        },
      };
      assert.throws(
        () => api.readBytes(file, 1024, io, file),
        (error) => {
          assert.equal(error.code, expected);
          if (api === current) assert.equal(error.cause, cause);
          else assert.equal(error, cause);
          return true;
        },
      );
      assert.equal(reads, 0);
      assert.equal(closes, 1);
      assert.equal(fs.readFileSync(file, "utf8"), '{"retained":true}');
    }
  });
}

test("matching path evidence permits the bounded read; a foreign inode still fails", (t) => {
  const { file } = fixture(t);
  for (const api of [previous, current]) {
    assert.equal(
      api
        .readBytes(file, 1024, { ...fs, realpathSync: () => file }, file)
        .toString(),
      '{"retained":true}',
    );
    assert.throws(
      () =>
        api.readBytes(
          file,
          1024,
          { ...fs, realpathSync: () => file + ".foreign" },
          file,
        ),
      { code: "INVALID_ARTIFACT" },
    );
    assert.throws(() => api.readBytes(file + ".absent", 1024, fs, file), {
      code: "ENOENT",
    });
  }
});

test("artifact store distinguishes an absent record from failed inode verification", async (t) => {
  const { root } = fixture(t);
  const store = createArtifactStore(root);
  const context = {
    version: 1,
    clientId: "client",
    requestId: "request",
    sessionId: null,
    projectId: "project",
    documentId: "document",
    instanceId: null,
    purpose: null,
  };
  assert.equal(await store.read(context, "absent"), null);
  const id = await store.write(
    context,
    '{"retained":true}',
    "application/json",
  );
  const file = path.join(root, ".cad", "artifacts", id + ".json");
  const retained = fs.readFileSync(file);
  const original = fs.realpathSync;
  const cause = Object.assign(new Error("missing proc evidence"), {
    code: "ENOENT",
  });
  try {
    fs.realpathSync = function (value, ...args) {
      if (String(value).startsWith("/proc/self/fd/")) throw cause;
      return original.call(this, value, ...args);
    };
    await assert.rejects(
      store.read(context, id),
      (error) => error.code === "STORAGE_UNAVAILABLE" && error.cause === cause,
    );
  } finally {
    fs.realpathSync = original;
  }
  assert.deepEqual(fs.readFileSync(file), retained);
  assert.equal(await store.read(context, "absent"), null);
});
