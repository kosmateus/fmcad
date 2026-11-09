import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import {
  normalizedAssertion,
  reviewAssertionPorts,
} from "./assertion-port-review";

test("port syntax review preserves values, operators, optional access and literal contents", () => {
  const equivalent = [
    ["assert.equal(row.name, 'five')", 'assert.equal(row["name"]!, "five",)'],
    ["assert.equal((row as Row).value, 5)", "assert.equal(row.value, 5)"],
    ["assert.ok((x satisfies boolean))", "assert.ok(x)"],
  ];
  for (const [before, after] of equivalent)
    assert.equal(normalizedAssertion(before!), normalizedAssertion(after!));
  const distinct = [
    ["assert.equal(value, 5)", "assert.equal(value, 6)"],
    ["assert.ok(value < 5)", "assert.ok(value <= 5)"],
    ["assert.ok(row.name)", "assert.ok(row?.name)"],
    ["assert.match(value, /pass/i)", "assert.match(value, /fail/i)"],
    ["assert.match(value, /pass/i)", "assert.match(value, /pass/)"],
    ["assert.equal(value, 'a b')", "assert.equal(value, 'ab')"],
    ["assert.equal(a + b * c, d)", "assert.equal((a + b) * c, d)"],
    ["assert.deepEqual([1,,2], value)", "assert.deepEqual([1,2], value)"],
    ["assert.equal((a,b), c)", "assert.equal(a, c)"],
    ["assert.equal(tag`a\\nb`, value)", "assert.equal(tag`a\nb`, value)"],
    ["assert.equal(object.#id, value)", "assert.equal(object['#id'], value)"],
  ];
  for (const [before, after] of distinct)
    assert.notEqual(
      normalizedAssertion(before!),
      normalizedAssertion(after!),
      before,
    );
  assert.equal(normalizedAssertion("assert len(items) == 2"), null);
  assert.equal(normalizedAssertion("assert.ok(a); assert.ok(b)"), null);
});

test("frozen port review retains every removed site and never reuses a replacement", () => {
  const root = path.resolve(__dirname, "../../..");
  const actual = reviewAssertionPorts(root);
  const expected = JSON.parse(
    fs.readFileSync(
      path.join(root, "tests/live-assertion-port-review.json"),
      "utf8",
    ),
  );
  assert.deepEqual(actual, expected);
  for (const source of actual.sources) {
    assert.equal(
      new Set(source.syntaxPairs.map((pair) => pair.after)).size,
      source.syntaxPairs.length,
    );
    const old = source.syntaxPairs
      .map((pair) => pair.before)
      .concat(source.openRemovedIds);
    assert.equal(new Set(old).size, old.length);
    assert.ok(
      source.openRemovedIds.length > 0,
      "Do not infer full semantic equivalence from syntax pairs",
    );
  }
  assert.equal(
    actual.sources.reduce(
      (sum, source) =>
        sum + source.syntaxPairs.length + source.openRemovedIds.length,
      0,
    ),
    396,
  );
});
