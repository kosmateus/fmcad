"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "../..");
const header = "# FMCAD native source envelope v1\n";

function decodeNativeProgram(source) {
  const headerIndex = source.indexOf(header);
  if (headerIndex < 0) return source;
  const decoded = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      path.join(projectRoot, "runtime/python/entrypoints/source_units.py"),
    ],
    {
      input: JSON.stringify({ source: source.slice(headerIndex) }),
      encoding: "utf8",
    },
  );
  assert.equal(decoded.status, 0, decoded.stderr || decoded.error?.message);
  const result = JSON.parse(decoded.stdout);
  const nativeSource = result.units.find(
    (unit) => unit.filename === "<fmcad-native-source>",
  );
  assert.ok(nativeSource, "final wire must contain a valid native envelope");
  return nativeSource.source;
}

function nativeReceipts(input, root, instance) {
  let source = decodeNativeProgram(input);
  const receipts = [];
  for (let depth = 0; depth < 8; depth++) {
    source = decodeNativeProgram(source);
    const binding = source.match(
      /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/,
    );
    const filename = source.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
    if (binding && filename && binding[1] && filename[1]) {
      const record = JSON.parse(JSON.parse(binding[1]));
      const file = JSON.parse(filename[1])
        .replace(/^\\\\wsl\$\\[^\\]+/, "")
        .replaceAll("\\", "/");
      assert.ok(
        file.startsWith(root + path.sep),
        "synthetic receipts must stay inside the isolated test directory",
      );
      const publicPythonResult = record.publicPythonResultSchema
        ? {
            schema: record.publicPythonResultSchema,
            value: {
              success: true,
              stdout: source.includes("FUSION_ADDIN_STDIO_OK")
                ? "FUSION_ADDIN_STDIO_OK\n"
                : "",
              stderr: "",
            },
          }
        : undefined;
      const probeObservation = source.includes("FMCAD_QUEUE_INSTANCE")
        ? { schema: "fmcad-instance-probe-v1", identity: instance }
        : undefined;
      receipts.push({
        file,
        value: {
          ...record,
          terminal: true,
          outcome: "succeeded",
          ...(probeObservation ? { probeObservation } : {}),
          ...(publicPythonResult ? { publicPythonResult } : {}),
          instance,
        },
      });
    }
    const wrapped = source.match(/exec\(compile\(("(?:\\.|[^"\\])*")/);
    if (!wrapped) return receipts;
    assert.ok(wrapped[1]);
    source = JSON.parse(wrapped[1]);
  }
  assert.fail("unexpected fake script nesting");
}

module.exports = { decodeNativeProgram, nativeReceipts };
