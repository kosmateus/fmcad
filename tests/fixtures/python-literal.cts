import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function decodePythonLiteral(source: string): unknown {
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      "import ast,json,sys; print(json.dumps(ast.literal_eval(sys.stdin.read()), allow_nan=False))",
    ],
    {
      input: source,
      encoding: "utf8",
      maxBuffer: Math.max(65536, Buffer.byteLength(source) * 8),
    },
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return JSON.parse(result.stdout) as unknown;
}

export = decodePythonLiteral;
