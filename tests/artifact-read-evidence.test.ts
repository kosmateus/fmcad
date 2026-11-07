import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
import type {
  RequestContext,
  ArtifactId,
} from "../packages/core/src/domain/contracts.js";
const fs = load("node:fs") as typeof import("node:fs");
type Records =
  typeof import("../packages/node-adapters/src/persistence/records.js");
const { id: identity } = load(
  "./src/dist/core/domain/contracts.js",
) as typeof import("../packages/core/src/domain/contracts.js");
const current = load(
  "./src/dist/node-adapters/persistence/records.js",
) as Records;
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
) => unknown;
const previous = historical(
  "04fa9e1fd0dab98ea7a8c49f3a26fe46658f07f6",
  "packages/node-adapters/src/persistence/records.ts",
) as Records;
const { createArtifactStore } = load(
  "./src/dist/node-adapters/persistence/artifact-store.js",
) as typeof import("../packages/node-adapters/src/persistence/artifact-store.js");
function fixture(t: TestContext) {
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
    ] as const) {
      let reads = 0,
        closes = 0;
      const io = { ...fs };
      t.mock.method(io, "realpathSync", (value: import("node:fs").PathLike) => {
        assert.match(String(value), /^\/proc\/self\/fd\/\d+$/);
        throw cause;
      });
      t.mock.method(
        io,
        "readSync",
        (
          fd: number,
          buffer: Buffer,
          offset: number,
          length: number,
          position: number | null,
        ) => {
          reads++;
          return fs.readSync(fd, buffer, offset, length, position);
        },
      );
      t.mock.method(io, "closeSync", (fd: number) => {
        closes++;
        return fs.closeSync(fd);
      });
      assert.throws(
        () => api.readBytes(file, 1024, io, file),
        (error) => {
          assert.ok(error instanceof Error && "code" in error);
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
    const io = { ...fs };
    t.mock.method(io, "realpathSync", () => file);
    assert.equal(
      api.readBytes(file, 1024, io, file).toString(),
      '{"retained":true}',
    );
    t.mock.method(io, "realpathSync", () => file + ".foreign");
    assert.throws(() => api.readBytes(file, 1024, io, file), {
      code: "INVALID_ARTIFACT",
    });
    assert.throws(() => api.readBytes(file + ".absent", 1024, fs, file), {
      code: "ENOENT",
    });
  }
});

test("artifact store distinguishes an absent record from failed inode verification", async (t) => {
  const { root } = fixture(t);
  const store = createArtifactStore(root);
  const context: RequestContext = {
    version: 1,
    clientId: identity("client", "client"),
    requestId: identity("request", "request"),
    sessionId: null,
    projectId: identity("project", "project"),
    documentId: identity("document", "document"),
    instanceId: null,
    purpose: null,
  };
  assert.equal(await store.read(context, "absent" as ArtifactId), null);
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
    t.mock.method(
      fs,
      "realpathSync",
      (value: import("node:fs").PathLike, ...args: unknown[]) => {
        if (String(value).startsWith("/proc/self/fd/")) throw cause;
        return Reflect.apply(original, fs, [value, ...args]) as string | Buffer;
      },
    );
    await assert.rejects(
      store.read(context, id),
      (error) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "STORAGE_UNAVAILABLE" &&
        error.cause === cause,
    );
  } finally {
    t.mock.restoreAll();
  }
  assert.deepEqual(fs.readFileSync(file), retained);
  assert.equal(await store.read(context, "absent" as ArtifactId), null);
});
