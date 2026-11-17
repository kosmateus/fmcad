"use strict";

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { decodeNativeProgram } = require("./native-source-envelope.cjs");

function runBoundInstanceProbe(script, identity) {
  const source = decodeNativeProgram(script);
  const pathMatch = source.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
  if (!pathMatch) throw new Error("Bound instance probe has no receipt path");
  const receiptPath = JSON.parse(pathMatch[1])
    .replace(/^\\\\wsl\$\\[^\\]+/, "")
    .replaceAll("\\", "/");
  const runnable = source.replace(
    pathMatch[0],
    `_qr_path = ${JSON.stringify(receiptPath)}`,
  );
  const separator = identity.birth.lastIndexOf(":");
  if (separator < 1)
    throw new Error(
      "Fake instance birth must include boot ID and process ticks",
    );
  const bootId = identity.birth.slice(0, separator);
  const processTicks = identity.birth.slice(separator + 1);
  const stat = `${identity.pid} (production fake) ${["S", ...Array(18).fill("0"), processTicks].join(" ")}`;
  const python = `import builtins, io, os, sys, types
_open = builtins.open
def _fixture_open(file, *args, **kwargs):
    if file == '/proc/self/stat':
        return io.StringIO(${JSON.stringify(stat)})
    if file == '/proc/sys/kernel/random/boot_id':
        return io.StringIO(${JSON.stringify(bootId + "\n")})
    return _open(file, *args, **kwargs)
builtins.open = _fixture_open
os.getpid = lambda: ${identity.pid}
_app = types.SimpleNamespace(version=${JSON.stringify(identity.version)},
    userInterface=types.SimpleNamespace(activeCommand=${JSON.stringify(identity.activeCommand || "SelectCommand")}),
    documents=types.SimpleNamespace(count=0, item=lambda index: None))
_core = types.ModuleType('adsk.core')
_core.Application = types.SimpleNamespace(get=lambda: _app)
_adsk = types.ModuleType('adsk')
_adsk.core = _core
sys.modules['adsk'] = _adsk
sys.modules['adsk.core'] = _core
`;
  const executed = spawnSync(
    "python3",
    ["-c", python + runnable + "\nrun(None)\n"],
    { encoding: "utf8" },
  );
  if (executed.status !== 0)
    throw new Error(
      executed.stderr ||
        executed.error?.message ||
        "Offline instance probe failed",
    );
  return {
    text: executed.stdout,
    receipt: JSON.parse(fs.readFileSync(receiptPath, "utf8")),
  };
}

module.exports = { runBoundInstanceProbe };
