"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { decodeNativeProgram } = require("./native-source-envelope.cjs");

function runStartupProbe(input, scenario = "valid", reference) {
  let script = input;
  for (let depth = 0; depth < 8; depth++) {
    script = decodeNativeProgram(script);
    if (script.includes("_qr_binding_value = _qr_cast(object,")) break;
    const nested = script.match(/exec\(compile\(("(?:\\.|[^"\\])*")/);
    if (!nested) throw Error("Actual bound probe wrapper absent");
    script = JSON.parse(nested[1]);
  }
  const executed = spawnSync(
    "python3",
    ["-I", "-S", "-B", path.join(__dirname, "startup-observation-sdk.py")],
    {
      input: JSON.stringify({ script, scenario, reference }),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (executed.error) throw executed.error;
  const report = executed.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("FAKE_STARTUP_REPORT "));
  if (!report) throw Error(executed.stderr || "Fake SDK report absent");
  return {
    failed: executed.status !== 0,
    text: executed.stdout,
    stderr: executed.stderr,
    report: JSON.parse(report.slice("FAKE_STARTUP_REPORT ".length)),
  };
}
module.exports = { runStartupProbe };
