import test from "node:test";
import assert from "node:assert/strict";
import { fmcad, at, list, number, text } from "./offline-cli";

test("gm01: G01-01 definition expand isolates nested scope and binds named inputs", () => {
  const data = {
    formatVersion: 1,
    runId: "scope",
    definitions: {
      leaf: {
        inputs: ["part"],
        operations: [
          {
            id: "seed",
            operation: "sketch.create",
            component: { $input: "part" },
            data: { name: "Section", plane: "XY" },
          },
        ],
        outputs: { sketch: { $ref: "seed.result.sketch" } },
      },
    },
    operations: [
      { id: "comp", operation: "component.create", data: { name: "Owner" } },
      {
        id: "one",
        use: "leaf",
        inputs: { part: { $ref: "comp.result.component" } },
      },
    ],
    outputs: { sketch: { $ref: "one.outputs.sketch" } },
  };
  const out = fmcad(["definition", "expand", "--data", JSON.stringify(data)]);
  assert.equal(at(out, "success"), true, JSON.stringify(at(out, "errors")));
  assert.equal(at(out, "status"), "pass");
  assert.equal(list(at(out, "operations")).length, 2);
  assert.equal(at(out, "plan", "steps"), 2);
  assert.equal(at(out, "operations", 1, "operation"), "sketch.create");
  assert.deepEqual(at(out, "operations", 1, "component"), {
    $ref: "comp.result.component",
  });
  assert.ok(
    at(out, "exports", "sketch"),
    "expected a named exported sketch reference",
  );
});

test("gm01: G01-02 definition expand expands finite repeat/forEach with lexical locals", () => {
  const data = {
    formatVersion: 1,
    runId: "loops",
    operations: [
      {
        id: "outer",
        repeat: 2,
        as: "outerItem",
        index: "outerIndex",
        operations: [
          {
            id: "inner",
            forEach: [{ name: "X" }],
            operations: [
              {
                id: "read",
                operation: "entity.list",
                data: { kind: "body" },
                component: { $local: "item.name" },
              },
            ],
            outputs: { value: { $local: "outerIndex" } },
          },
        ],
        outputs: { row: { $ref: "inner.outputs" } },
      },
      {
        id: "empty",
        repeat: 0,
        operations: [{ id: "read", operation: "entity.list", data: {} }],
      },
    ],
    outputs: {
      empty: { $ref: "empty.outputs" },
      rows: { $ref: "outer.outputs" },
    },
  };
  const out = fmcad(["definition", "expand", "--data", JSON.stringify(data)]);
  assert.equal(at(out, "success"), true, JSON.stringify(at(out, "errors")));
  assert.deepEqual(at(out, "exports", "empty"), []);
  assert.deepEqual(at(out, "exports", "rows"), [
    { row: [{ value: 0 }] },
    { row: [{ value: 1 }] },
  ]);
  assert.deepEqual(
    list(at(out, "operations")).map((s) => at(s, "component")),
    ["X", "X"],
  );
});

test("gm01: G01-03 definition inspect reports the full step/scope/mutation plan", () => {
  const out = fmcad([
    "definition",
    "inspect",
    "--file",
    "tests/fixtures/gm01-native.json",
  ]);
  assert.equal(at(out, "success"), true, JSON.stringify(at(out, "errors")));
  assert.equal(at(out, "status"), "pass");
  assert.equal(list(at(out, "operations")).length, 8);
  assert.equal(at(out, "plan", "steps"), 8);
  assert.equal(at(out, "plan", "mutations"), 8);
  assert.ok(
    number(at(out, "plan", "nodes")) >= 8,
    "expected a visited-node count in the plan",
  );
  assert.ok(
    Array.isArray(at(out, "plan", "scopes")),
    "expected per-step scope paths",
  );
});

test("gm01: G01-04 definition inspect validates durable recipe bindings cover every use", () => {
  const out = fmcad([
    "definition",
    "inspect",
    "--file",
    "tests/fixtures/gm01-native.json",
  ]);
  assert.equal(at(out, "success"), true, JSON.stringify(at(out, "errors")));
  assert.equal(list(at(out, "recipe", "bindings")).length, 2);
  for (const binding of list(at(out, "recipe", "bindings"))) {
    assert.ok(at(binding, "target", "$ref"), "expected a resolved target $ref");
    assert.equal(at(binding, "role"), "AlongDistance");
    assert.match(text(at(binding, "target", "$ref")), /^scope_/);
  }
});

test("gm01: G01-05 definition inspect refuses cycles and unbound refs", () => {
  const cycle = {
    formatVersion: 1,
    definitions: {
      self: { operations: [{ id: "c", use: "self", inputs: {} }] },
    },
    operations: [{ id: "root", use: "self", inputs: {} }],
  };
  assert.throws(
    () => fmcad(["definition", "inspect", "--data", JSON.stringify(cycle)]),
    /cycle/i,
  );
  const unbound = {
    formatVersion: 1,
    operations: [{ id: "a", use: "missing", inputs: {} }],
  };
  assert.throws(
    () => fmcad(["definition", "inspect", "--data", JSON.stringify(unbound)]),
    /Unknown definition/i,
  );
});
