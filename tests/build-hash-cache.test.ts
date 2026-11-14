import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(path.resolve(__dirname, "../../package.json"));
const { buildHash } = load("./src/queue-instance") as Pick<
  ReturnType<
    typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
  >,
  "buildHash"
>;

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-build-cache-"));
  for (const name of ["bin", "src", "assets"])
    fs.mkdirSync(path.join(root, name));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "assets", "worker.py"), 'print("source")\n');
  t.after(() => {
    for (const directory of ["assets/__pycache__", "assets", "bin", "src"]) {
      const full = path.join(root, directory);
      if (!fs.existsSync(full)) continue;
      for (const file of fs.readdirSync(full))
        fs.unlinkSync(path.join(full, file));
      fs.rmdirSync(full);
    }
    fs.unlinkSync(path.join(root, "package.json"));
    fs.rmdirSync(root);
  });
  return root;
}

test("offline Python bytecode cache creation/update does not change the pinned executable source build", (t) => {
  const root = fixture(t),
    initial = buildHash(root);
  const cache = path.join(root, "assets", "__pycache__");
  fs.mkdirSync(cache);
  const file = path.join(cache, "worker.cpython-312.pyc");
  fs.writeFileSync(file, "first runtime cache");
  assert.equal(buildHash(root), initial);
  fs.writeFileSync(file, "updated runtime cache");
  fs.writeFileSync(
    path.join(root, "assets", "worker.pyc"),
    "legacy bytecode cache",
  );
  assert.equal(buildHash(root), initial);
  fs.writeFileSync(
    path.join(root, "assets", "worker.py"),
    'print("changed source")\n',
  );
  assert.notEqual(
    buildHash(root),
    initial,
    "actual Python source changes must still fence SDK work",
  );
});

test("source symlinks are still rejected rather than hidden by cache handling", (t) => {
  const root = fixture(t);
  fs.symlinkSync("worker.py", path.join(root, "assets", "linked.py"));
  assert.throws(() => buildHash(root), { code: "UNPINNED_BUILD" });
});
