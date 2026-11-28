import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { planCameraToken } from "../packages/node-adapters/src/python/camera-token-registry.js";

const root = process.cwd();
const kinds: unknown[] = [
  undefined,
  null,
  false,
  0,
  "",
  [],
  {},
  "component",
  "occurrence",
  "parameter",
  "body",
  "Component",
  "feature",
  "CustomFeature",
  "other",
  true,
  ["component"],
];

test("known token plans bind only canonical source and guarantee eligibility precisely", () => {
  for (const kind of kinds) {
    const raw = JSON.stringify({ token: "TOKEN", kind });
    const plan = planCameraToken(root, raw);
    assert.ok(plan);
    assert.equal(plan.receiver, "design");
    assert.equal(plan.acceptsRaw, false);
    assert.equal(
      plan.alwaysEligibleAliasTarget,
      ["component", "occurrence", "parameter"].includes(String(kind)) &&
        typeof kind === "string",
    );
    assert.doesNotMatch(
      plan.projectedSources[0]!.source,
      /json|loads|raw|ctx|_CAD_KINDS|_cad_kind|_cad_cast/,
    );
    assert.match(
      plan.projectedSources[0]!.source,
      /_cad_unique\(candidates, 'Entity token'\)/,
    );
    assert.doesNotMatch(
      plan.projectedSources[0]!.source,
      /len\(unique\)|list\(design\.findEntityByToken/,
    );
    assert.deepEqual(plan.definitions[0]!.dependencies, [
      { symbol: "_cad_unique" },
    ]);
    assert.deepEqual(plan, planCameraToken(root, raw));
  }
  assert.equal(planCameraToken(root, '"name"'), null);
  assert.equal(
    planCameraToken(root, '{"token":"TOKEN","path":"Part:1"}'),
    null,
  );
  assert.equal(planCameraToken(root, '{"token":"TOKEN","query":{}}'), null);
});

test("projected callbacks match canonical token results, diagnostics and property effects", () => {
  const raws = kinds.map((kind) => JSON.stringify({ token: "TOKEN", kind }));
  raws.push(JSON.stringify({ token: "raise", kind: "component" }));
  raws.push(
    JSON.stringify({
      token: "'\n); raise Exception('not code') #",
      kind: "component",
    }),
  );
  const plans = raws.map((raw) => {
    const plan = planCameraToken(root, raw);
    assert.ok(plan);
    return {
      raw,
      symbol: plan.resolverSymbol,
      source: plan.projectedSources[0]!.source,
    };
  });
  const program = `
import ast, json, types, typing
core = ast.parse(${JSON.stringify(readFileSync(join(root, "assets/cad/core.py"), "utf8"))})
aliases = ast.parse(${JSON.stringify(readFileSync(join(root, "runtime/python/fmcad/adapters/fusion/camera_alias.py"), "utf8"))})
names = {"_cad_type", "_cad_kind", "_cad_unique"}
nodes = [node for node in core.body if
         isinstance(node, ast.FunctionDef) and node.name in names or
         isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "_CAD_KINDS" for t in node.targets)]
nodes += [node for node in aliases.body if isinstance(node, ast.FunctionDef) and node.name == "_camera_alias_token"]
source = ast.unparse(ast.Module(body=nodes, type_ignores=[]))
ns = {"json":json, "_cad_cast":typing.cast}
exec("from __future__ import annotations\\n" + source, ns)
class Entity:
    def __init__(self, name):
        self.name, self.reads = name, 0
    @property
    def objectType(self):
        self.reads += 1
        if self.name == "broken": raise RuntimeError("invalid entity")
        return "adsk::fusion::" + self.name
class Design:
    def __init__(self, items): self.items, self.calls = items, []
    def findEntityByToken(self, token):
        self.calls.append(token)
        if token == "raise": raise RuntimeError("sdk token failure")
        return self.items
def outcome(action):
    try: return ("value", action())
    except Exception as error: return (type(error).__name__, str(error))
count = 0
for plan in json.loads(${JSON.stringify(JSON.stringify(plans))}):
    local = {"_cad_unique": ns["_cad_unique"]}
    exec("from __future__ import annotations\\n" + plan["source"], local)
    callback = local[plan["symbol"]]
    for labels in ([], ["Component"], ["Occurrence"], ["UserParameter"], ["BRepBody"],
                   ["Feature"], ["ExtrudeFeature"], ["feature"], ["component"],
                   ["Component", "Occurrence"], ["Component", "Component"], ["broken"]):
        items = [Entity(name) for name in labels]
        design = Design(items)
        expected = outcome(lambda: ns["_camera_alias_token"](types.SimpleNamespace(design=design), plan["raw"]))
        expected_calls, expected_reads = design.calls[:], [item.reads for item in items]
        design.calls.clear()
        for item in items: item.reads = 0
        actual = outcome(lambda: callback(design))
        assert actual == expected, (plan["raw"], labels, expected, actual)
        assert design.calls == expected_calls
        assert [item.reads for item in items] == expected_reads
        count += 1
print(count)
`;
  const result = spawnSync("python3", ["-I", "-S", "-B", "-c", program], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Number(result.stdout.trim()), plans.length * 12);
});
