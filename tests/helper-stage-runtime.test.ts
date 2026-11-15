import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

test("helper stage validation loads the staged service from the host runtime layout", async () => {
  const root = process.cwd();
  const filename = path.join(root, "src/composition/stage-dependencies.js");
  const source = fs.readFileSync(
    path.join(root, "src/dist/composition/stage-dependencies.js"),
    "utf8",
  );
  const load = createRequire(filename);
  const module = {
    exports: {} as {
      createAuthenticatedStageDependencies(input: unknown): Promise<unknown>;
    },
  };
  const evaluate = vm.runInThisContext(
    "(function(require,module,exports,__filename,__dirname){\n" +
      source +
      "\nreadCommittedQueueSnapshot = async () => ({jobs:{owned:{id:'owned',request:{payload:{kind:'run',request:{helperVersion:'cad-v1'}}}}}});\n})",
    { filename },
  );
  evaluate(load, module, module.exports, filename, path.dirname(filename));
  await assert.rejects(
    module.exports.createAuthenticatedStageDependencies({
      brokerDirectory: root,
      jobId: "owned",
    }),
    (error: Error & { code?: string }) => {
      assert.notEqual(error.code, "MODULE_NOT_FOUND");
      assert.match(error.message, /run|invocation|version|script|request/i);
      return true;
    },
  );
});
