import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { record, text } from "./integration/offline-cli";
const root = process.cwd(),
  load = createRequire(__filename);
type Command = (...args: unknown[]) => Promise<unknown>;
function host(source: string) {
  const output = { stdout: "", stderr: "" };
  const target = { exports: {} };
  const shot = () => {};
  const dependency = (name: string): unknown => {
    if (name === "node:module") return { createRequire: () => dependency };
    if (name.endsWith("core/application/documents/commands"))
      return load(
        path.join(root, "src/dist/core/application/documents/commands"),
      );
    if (name.endsWith("node-adapters/persistence/document-commands"))
      return load(
        path.join(root, "src/dist/node-adapters/persistence/document-commands"),
      );
    if (name.endsWith("/shot")) return { shotCmd: shot };
    assert.fail(`Unexpected dependency ${name}`);
  };
  vm.runInNewContext(
    `(function(require,module,exports,process,__filename){${source}\n})`,
    {},
  )(
    dependency,
    target,
    target.exports,
    {
      stdout: {
        write: (value: string) => {
          output.stdout += value;
        },
      },
      stderr: {
        write: (value: string) => {
          output.stderr += value;
        },
      },
    },
    path.join(root, "src/dist/composition/library-docops.js"),
  );
  const exports = record(target.exports);
  assert.equal(exports["shotCmd"], shot);
  return { exports, output };
}
const cases: [string, ...unknown[]][] = [
  ["docSearchCmd", []],
  ["docSearchCmd", ["α", "--project", "Pinned"]],
  ["docSearchCmd", ["first", "last", "--project"]],
  ["docListCmd"],
  ["docRecentCmd"],
  ["docOpenCmd", ["Part"]],
  ["docOpenCmd", []],
  ["docSaveCmd"],
  ["docCloseCmd", []],
  ["docCloseCmd", ["--save", "--discard"]],
  ["docNewCmd", []],
  ["docNewCmd", ["--name", "Part α", "ignored", "--name", "Final"]],
  ["docNewCmd", ["--name"]],
  ["undoRedoCmd", "undo"],
  ["undoRedoCmd", "redo"],
  ["licensingCmd"],
  ["activeCmd"],
  [
    "fileDownloadCmd",
    ["Part", "--out", "/result/a.step"],
    (value: string) => "mapped:" + value,
  ],
  ["fileDownloadCmd", ["Part", "--out"], (value: string) => "mapped:" + value],
  ["fileDownloadCmd", []],
];
test("docops composition preserves every retained export, command parse, exact dispatch and publication", async () => {
  const source = fs.readFileSync(
    path.join(root, "tests/fixtures/public-host-baseline/docops.js.txt"),
    "utf8",
  );
  const provenance = record(
    JSON.parse(
      fs.readFileSync(
        path.join(root, "tests/fixtures/public-host-baseline/provenance.json"),
        "utf8",
      ),
    ),
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    record(provenance["src/docops.js"])["sha256"],
  );
  const current = fs.readFileSync(
    path.join(root, "src/dist/composition/library-docops.js"),
    "utf8",
  );
  assert.deepEqual(
    Object.keys(host(current).exports).sort(),
    Object.keys(host(source).exports).sort(),
  );
  for (const failure of [false, true])
    for (const [name, ...args] of cases) {
      const observe = async (code: string) => {
        const h = host(code),
          calls: unknown[] = [];
        const client = {
          async callTool(data: unknown, tool: unknown) {
            calls.push({ data, tool });
            if (failure)
              throw Object.assign(new Error("uncertain dispatch"), {
                code: "UNKNOWN_RPC",
              });
            return {
              text: "retained text",
              data: { results: [{ name: "Part", id: "file-id" }] },
              failed: false,
            };
          },
        };
        let result: unknown;
        try {
          const fn = h.exports[name];
          assert.equal(typeof fn, "function");
          result = await (fn as Command)(client, ...args);
        } catch (error) {
          result = {
            name: text(record(error)["name"]),
            message: text(record(error)["message"]),
            code: record(error)["code"],
          };
        }
        return JSON.parse(
          JSON.stringify({ result, calls, ...h.output }),
        ) as unknown;
      };
      assert.deepEqual(
        await observe(current),
        await observe(source),
        `${name}: failure=${failure}`,
      );
    }
});
