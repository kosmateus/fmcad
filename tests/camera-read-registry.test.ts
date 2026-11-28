import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const load = createRequire(path.resolve("tests/camera-read-registry.test.ts"));
const { prepareCanonicalRegisteredPayload } = load(
  "../packages/node-adapters/dist/python/registered-payload.js",
) as typeof import("../packages/node-adapters/src/python/registered-payload.js");
const { cameraSaveHandlerPlan: plan, cameraSaveCanonicalSources: sources } =
  load(
    "../packages/node-adapters/dist/python/camera-read-registry.js",
  ) as typeof import("../packages/node-adapters/src/python/camera-read-registry.js");
const { planPayloadDependencies } = load(
  "../packages/core/dist/application/cad/payload-dependencies.js",
) as typeof import("../packages/core/src/application/cad/payload-dependencies.js");

const wrapper = {
  id: "wrapper",
  filename: "<test-wrapper>",
  role: "wrapper" as const,
  source: "",
};
const prepare = () =>
  prepareCanonicalRegisteredPayload(
    process.cwd(),
    plan.definitions,
    sources,
    plan.roots,
    plan.conditions,
    wrapper,
  );

// This oracle is intentionally independent of the registry and its planner.
const requiredFunctions = [
  "_io_camera_save",
  "_io_camera_viewport",
  "_io_camera_identity",
  "_io_camera_state",
  "_cad_fields",
  "_cad_xyz",
  "_cad_require_result",
];

function execute(script: string, remove?: string, extra = "") {
  return spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      `
import ast, json, sys, types
source = ${JSON.stringify(script)}
tree = ast.parse(source)
expected = set(${JSON.stringify(requiredFunctions)})
observed = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
assert observed == expected, (observed, expected)
imports = sorted(ast.unparse(node) for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom)))
assert imports == ['from typing import cast as _cad_cast', 'import adsk.core'], imports
assert len(tree.body) == len(expected) + len(imports), 'unexpected initialization'
sdk = types.ModuleType('adsk')
sdk.core = types.ModuleType('adsk.core')
sdk.core.CameraTypes = types.SimpleNamespace(OrthographicCameraType=0, PerspectiveCameraType=1, PerspectiveWithOrthoFacesCameraType=2)
sys.modules.update({'adsk': sdk, 'adsk.core': sdk.core})
namespace = {}
exec(compile(tree, '<registered-camera>', 'exec'), namespace)
${remove ? `del namespace[${JSON.stringify(remove)}]` : ""}
point = types.SimpleNamespace(x=1, y=2, z=3)
doc = types.SimpleNamespace(name='owned', creationId='owned-id', dataFile=None)
states = []
for kind in range(3):
    camera = types.SimpleNamespace(cameraType=kind, eye=point, target=point, upVector=point, perspectiveAngle=0.7, getExtents=lambda: (True, 5, 6))
    class Viewport:
        parentDocument = doc
        def __init__(self):
            object.__setattr__(self, 'camera', camera)
        def __setattr__(self, key, value):
            raise AssertionError('camera.save must never write to the viewport')
    viewport = Viewport()
    ctx = types.SimpleNamespace(doc=doc, app=types.SimpleNamespace(activeDocument=doc, activeViewport=viewport))
    state = namespace['_io_camera_save'](ctx, {})['state']
    states.append(state)
    for bad in ({'fit': True}, {'state': {}}, {'unknown': 1}):
        try:
            namespace['_io_camera_save'](ctx, bad)
        except ValueError:
            pass
        else:
            raise AssertionError('unknown inputs accepted')
    ctx.app.activeDocument = object()
    try:
        namespace['_io_camera_save'](ctx, {})
    except ValueError:
        pass
    else:
        raise AssertionError('inactive target accepted')
    ctx.app.activeDocument = doc
    viewport.__dict__['parentDocument'] = object()
    try:
        namespace['_io_camera_save'](ctx, {})
    except ValueError:
        pass
    else:
        raise AssertionError('foreign viewport accepted')
${extra}
print(json.dumps(states))
`,
    ],
    { encoding: "utf8" },
  );
}

test("camera.save registry executes only its exact canonical handler closure", () => {
  const artifact = prepare();
  assert.equal(artifact.units.length, 10);
  const result = execute(artifact.script);
  assert.equal(result.status, 0, result.stderr);
  const states = JSON.parse(result.stdout);
  assert.deepEqual(
    states.map((state: { cameraType: string }) => state.cameraType),
    [
      "OrthographicCameraType",
      "PerspectiveCameraType",
      "PerspectiveWithOrthoFacesCameraType",
    ],
  );
  assert.deepEqual(states[0].extents, [5, 6]);
  assert.equal(states[1].perspectiveAngle, 0.7);
  assert.equal(states[2].perspectiveAngle, 0.7);
  assert.ok(states.every((state: { units: string }) => state.units === "cm"));
});

test("independent oracle detects foreign definitions and every missing helper", () => {
  const artifact = prepare();
  assert.notEqual(
    execute(artifact.script + "\ndef _io_camera_restore(): pass\n").status,
    0,
  );
  for (const addition of ["import os", "_UNUSED = 1"])
    assert.notEqual(execute(artifact.script + "\n" + addition).status, 0);
  for (const symbol of [...requiredFunctions, "_cad_cast", "adsk"]) {
    const result = execute(artifact.script, symbol);
    assert.notEqual(result.status, 0, `Missing ${symbol} was not detected`);
  }
});

test("dependency planning fails closed for missing providers, cycles and conditions", () => {
  assert.throws(
    () =>
      planPayloadDependencies(
        [{ symbol: "a", sourceId: "a", dependencies: [{ symbol: "missing" }] }],
        ["a"],
        {},
      ),
    /Missing payload definition/,
  );
  assert.throws(
    () =>
      planPayloadDependencies(
        [{ symbol: "a", sourceId: "a", dependencies: [{ symbol: "a" }] }],
        ["a"],
        {},
      ),
    /Cyclic/,
  );
  assert.throws(
    () =>
      planPayloadDependencies(
        [
          {
            symbol: "a",
            sourceId: "a",
            dependencies: [{ symbol: "b", when: "variant" }],
          },
        ],
        ["a"],
        {},
      ),
    /Unresolved payload condition/,
  );
  assert.deepEqual(
    planPayloadDependencies(
      [
        {
          symbol: "root",
          sourceId: "root",
          dependencies: [{ symbol: "left" }, { symbol: "right" }],
        },
        {
          symbol: "left",
          sourceId: "left",
          dependencies: [{ symbol: "shared" }],
        },
        {
          symbol: "right",
          sourceId: "right",
          dependencies: [{ symbol: "shared" }],
        },
        { symbol: "shared", sourceId: "shared", dependencies: [] },
      ],
      ["root"],
      {},
    ),
    ["shared", "left", "right", "root"],
  );
});
