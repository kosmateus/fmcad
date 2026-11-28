import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(path.resolve(__dirname, "../../package.json"));
const { pythonLiteral, pythonValue } = load("./src/python") as {
  pythonLiteral(value: unknown): string;
  pythonValue(value: unknown): string;
};

test("Python payloads remain ASCII on the wire and round-trip Unicode and JSON types", () => {
  const value = {
    name: "Bryła2_日本語_😀",
    values: [true, false, null, 'quote"\\\n', "$&"],
  };
  const expression = pythonValue(value);
  assert.doesNotMatch(expression, /[^\x00-\x7f]/);
  const result = spawnSync(
    "python3",
    ["-c", `import json; print(json.dumps(${expression}))`],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), value);
});

test("Python JSON policy preserves legacy nonfinite projection and rejects undefined roots", () => {
  const expression = pythonValue({
    values: [NaN, Infinity, -Infinity],
    omitted: undefined,
  });
  const result = spawnSync(
    "python3",
    ["-c", `import json; print(json.dumps(${expression}))`],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { values: [null, null, null] });
  assert.throws(() => pythonValue(undefined), /JSON serializable/);
});

test("typed Python literals preserve the normalized JSON policy without a dynamic loader", () => {
  const value = {
    unicode: "Bryła_日本語_😀",
    controls: "\b\f\n\r\t\u0000",
    quote: '"\\',
    loneSurrogate: "\ud800",
    values: [true, false, null, NaN, Infinity, -Infinity, undefined],
    omitted: undefined,
  };
  const expression = pythonLiteral(value);
  assert.doesNotMatch(expression, /[^\x00-\x7f]/);
  assert.doesNotMatch(expression, /json|loads|__import__/);
  const result = spawnSync(
    "python3",
    ["-c", `import json; print(json.dumps(${expression}, ensure_ascii=True))`],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    JSON.parse(JSON.stringify(value)),
  );
  assert.throws(() => pythonLiteral(undefined), /JSON serializable/);
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.throws(() => pythonLiteral(cycle));
  assert.throws(() => pythonLiteral(1n));
});
