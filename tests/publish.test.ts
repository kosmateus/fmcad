import type { TestContext } from "node:test";
import type { PublishFileSystem } from "../packages/node-adapters/src/persistence/publish";
import { at, list } from "./integration/offline-cli";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { checkPublishTarget, publishComplete } = load(
  "./src/publish",
) as typeof import("../packages/node-adapters/src/persistence/publish");

async function directory(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fmcad-publish-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("publisher links only closed, fsynced complete UTF-8 content, then syncs directory", async (t) => {
  const dir = await directory(t);
  const target = path.join(dir, "out");
  const text = "🧩Zażółć\r\n".repeat(10000);
  const events: string[] = [];
  const io: PublishFileSystem = {
    ...fs,
    async open(name, flags, mode) {
      const file = await fs.open(name, flags, mode);
      const kind = name === dir ? "directory" : "file";
      return {
        async writeFile(data: string | Uint8Array) {
          events.push("write");
          await file.writeFile(data);
        },
        async sync() {
          events.push(kind + " sync");
          await file.sync();
        },
        async close() {
          events.push(kind + " close");
          await file.close();
        },
      };
    },
    async link(temp, dest) {
      events.push("link");
      await assert.rejects(fs.lstat(dest), { code: "ENOENT" });
      assert.deepEqual(await fs.readFile(temp), Buffer.from(text));
      await fs.link(temp, dest);
    },
  };
  await checkPublishTarget(target);
  await publishComplete(target, text, io);
  assert.deepEqual(events, [
    "write",
    "file sync",
    "file close",
    "link",
    "directory sync",
    "directory close",
  ]);
  assert.deepEqual(await fs.readFile(target), Buffer.from(text));
  assert.deepEqual(await fs.readdir(dir), ["out"]);
});

test("partial write, file sync and link failures leave destination absent and clean only own temp", async (t) => {
  const dir = await directory(t);
  const target = path.join(dir, "out");
  const unrelated = path.join(dir, ".snapshot-someone-else");
  await fs.writeFile(unrelated, "untouched");
  for (const stage of ["write", "sync", "link"]) {
    const io: PublishFileSystem = {
      ...fs,
      async open(name, flags, mode) {
        const file = await fs.open(name, flags, mode);
        return {
          async writeFile(data: string | Uint8Array) {
            if (stage === "write") {
              await file.writeFile("partial");
              throw new Error("injected write");
            }
            await file.writeFile(data);
          },
          async sync() {
            if (stage === "sync") throw new Error("injected sync");
            await file.sync();
          },
          close: () => file.close(),
        };
      },
      async link(temp, dest) {
        if (stage === "link") throw new Error("injected link");
        await fs.link(temp, dest);
      },
    };
    await assert.rejects(
      publishComplete(target, "complete", io),
      new RegExp("injected " + stage),
    );
    await assert.rejects(fs.lstat(target), { code: "ENOENT" });
    assert.deepEqual(await fs.readdir(dir), [".snapshot-someone-else"]);
    assert.equal(await fs.readFile(unrelated, "utf8"), "untouched");
  }
});

test("exclusive publication protects existing files, directories, dangling/live symlinks and hardlinks", async (t) => {
  const dir = await directory(t);
  const original = path.join(dir, "original");
  await fs.writeFile(original, "untouched");
  await fs.mkdir(path.join(dir, "directory"));
  await fs.symlink(original, path.join(dir, "symlink"));
  await fs.symlink(path.join(dir, "absent"), path.join(dir, "dangling"));
  await fs.link(original, path.join(dir, "hardlink"));
  const names = await fs.readdir(dir);
  for (const name of names) {
    const target = path.join(dir, name);
    await assert.rejects(publishComplete(target, "replacement"), {
      code: "EEXIST",
    });
    assert.deepEqual(await fs.readdir(dir), names);
    assert.equal(await fs.readFile(original, "utf8"), "untouched");
  }
  assert.equal(await fs.readlink(path.join(dir, "symlink")), original);
  assert.equal(
    (await fs.stat(path.join(dir, "hardlink"))).ino,
    (await fs.stat(original)).ino,
  );
});

test("failed exclusive temp creation never removes a file it did not create", async (t) => {
  const dir = await directory(t);
  let collision: string | undefined;
  const io: PublishFileSystem = {
    ...fs,
    async open(name) {
      collision = name;
      await fs.writeFile(name, "other owner", { flag: "wx" });
      throw Object.assign(new Error("temp collision"), { code: "EEXIST" });
    },
  };
  await assert.rejects(
    publishComplete(path.join(dir, "out"), "complete", io),
    /temp collision/,
  );
  assert.ok(collision);
  assert.equal(await fs.readFile(collision, "utf8"), "other owner");
});

test("directory sync failure reports failure but retains complete published file", async (t) => {
  const dir = await directory(t);
  const target = path.join(dir, "out");
  const io: PublishFileSystem = {
    ...fs,
    async open(name, flags, mode) {
      const file = await fs.open(name, flags, mode);
      if (name !== dir) return file;
      return {
        async writeFile() {
          assert.fail("Directory must never be written as a file");
        },
        async sync() {
          throw new Error("directory durability unconfirmed");
        },
        close: () => file.close(),
      };
    },
  };
  await assert.rejects(
    publishComplete(target, "complete", io),
    /durability unconfirmed/,
  );
  assert.equal(await fs.readFile(target, "utf8"), "complete");
  assert.deepEqual(await fs.readdir(dir), ["out"]);
});

test("cleanup failures remain secondary to the original write failure", async (t) => {
  const dir = await directory(t);
  const primary = Object.assign(new Error("partial write failed"), {
    code: "EWRITE",
  });
  const io: PublishFileSystem = {
    ...fs,
    async open(name, flags, mode) {
      const file = await fs.open(name, flags, mode);
      return {
        async writeFile() {
          await file.writeFile("partial");
          throw primary;
        },
        async sync() {
          assert.fail("Failed write must not reach sync");
        },
        async close() {
          await file.close();
          throw new Error("close failed");
        },
      };
    },
    async unlink() {
      throw new Error("unlink failed");
    },
  };
  await assert.rejects(
    publishComplete(path.join(dir, "out"), "complete", io),
    (error: unknown) => {
      assert.equal(error, primary);
      assert.equal(at(error, "code"), "EWRITE");
      assert.deepEqual(
        list(at(error, "cleanupErrors")).map((item) => at(item, "message")),
        ["close failed", "unlink failed"],
      );
      return true;
    },
  );
  await assert.rejects(fs.lstat(path.join(dir, "out")), { code: "ENOENT" });
});
