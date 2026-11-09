import { createRequire } from "node:module";
import type { ModelingApi, NativeRequest } from "./modeling-unit-test-support";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
const load = createRequire(
  path.join(process.cwd(), "tests/surface.test.ts"),
);
test.after(load("./fixtures/fake-wsl-platform.cjs")());
const { validateCad, buildCadScript, executeCad, catalog } =
  load("../src/cad") as ModelingApi;

const operations = [
  "surface.patch",
  "surface.stitch",
  "surface.trim",
  "surface.extend",
  "surface.offset",
  "surface.check",
];

test("GM08 surface operations are catalog reachable with schemaVersion 1 and frame component", () => {
  for (const operation of operations) {
    const entry = catalog[operation];
    assert.ok(entry, operation);
    assert.equal(entry.surface, true);
    assert.equal(entry.readOnly, operation === "surface.check");
    assert.deepEqual(validateCad(operation, entry.example), entry);
  }
});

test("GM08 model loft/sweep/revolve surface variants validate with solid:false", () => {
  const loft = {
    schemaVersion: 1,
    frame: "component",
    solid: false,
    profiles: [
      { kind: "profile", sketch: "Bottom", index: 0 },
      { kind: "profile", sketch: "Top", index: 0 },
    ],
  };
  assert.ok(validateCad("model.loft", loft));
  assert.ok(
    validateCad("model.sweep", {
      schemaVersion: 1,
      frame: "component",
      solid: false,
      profile: { kind: "openProfile", curves: ["curve"] },
      path: { kind: "path", curves: ["line"], chain: "none" },
    }),
  );
  assert.ok(
    validateCad("model.revolve", {
      schemaVersion: 1,
      frame: "component",
      solid: false,
      profile: { kind: "openProfile", curves: ["curve"] },
      axis: "X",
      angle: "90 deg",
    }),
  );
});

test("GM08 rejects invalid surface payloads before SDK dispatch", () => {
  const cases: [string, Record<string, unknown>][] = [
    [
      "surface.patch",
      { ...catalog["surface.patch"]!.example, schemaVersion: 2 },
    ],
    [
      "surface.patch",
      { ...catalog["surface.patch"]!.example, representation: "recipe" },
    ],
    [
      "surface.patch",
      { ...catalog["surface.patch"]!.example, continuity: "G3" },
    ],
    ["surface.patch", { ...catalog["surface.patch"]!.example, weight: -1 }],
    [
      "surface.stitch",
      { ...catalog["surface.stitch"]!.example, tolerance: "" },
    ],
    [
      "surface.trim",
      { ...catalog["surface.trim"]!.example, mode: "plan", removeCells: [0] },
    ],
    [
      "surface.trim",
      { ...catalog["surface.trim"]!.example, mode: "apply", removeCells: [0] },
    ],
    [
      "surface.trim",
      {
        ...catalog["surface.trim"]!.example,
        mode: "apply",
        plan: { x: 1 },
        removeCells: [0, 0],
      },
    ],
    [
      "surface.extend",
      { ...catalog["surface.extend"]!.example, type: "spline" },
    ],
    [
      "surface.extend",
      {
        ...catalog["surface.extend"]!.example,
        tangentChain: true,
        protected: ["SurfaceA"],
      },
    ],
    [
      "surface.offset",
      { ...catalog["surface.offset"]!.example, distance: "1" },
    ],
    [
      "surface.offset",
      {
        ...catalog["surface.offset"]!.example,
        tangentChain: true,
        protected: ["SurfaceA"],
      },
    ],
    ["surface.check", { ...catalog["surface.check"]!.example, samples: 1 }],
    ["surface.check", { ...catalog["surface.check"]!.example, samples: 1002 }],
    [
      "surface.check",
      {
        ...catalog["surface.check"]!.example,
        seams: [{ edgeA: "e", faceA: "f", edgeB: "g", faceB: "h", flip: true }],
      },
    ],
    ["surface.check", { ...catalog["surface.check"]!.example, budgetMs: 0 }],
    [
      "model.loft",
      {
        schemaVersion: 2,
        frame: "component",
        solid: false,
        profiles: ["a", "b"],
      },
    ],
    [
      "model.loft",
      {
        schemaVersion: 1,
        frame: "component",
        solid: false,
        profiles: ["a", "b"],
        endConditions: { start: { type: "tangent", angle: "5 deg" } },
      },
    ],
    [
      "model.loft",
      {
        schemaVersion: 1,
        frame: "component",
        solid: false,
        profiles: ["a", "b"],
        closed: true,
        endConditions: { end: { type: "free" } },
      },
    ],
    [
      "model.sweep",
      {
        schemaVersion: 1,
        frame: "component",
        solid: true,
        profile: "a",
        path: "p",
      },
    ],
  ];
  for (const [operation, data] of cases)
    assert.throws(
      () => validateCad(operation, data),
      `${operation}: ${JSON.stringify(data)}`,
    );
});

test("surface.check dispatches read-only and mutating operations differ", async () => {
  const requests: NativeRequest[] = [];
  const client = {
    callTool: async (request: NativeRequest) => {
      requests.push(request);
      return {
        text: "FMCAD_RESULT " + JSON.stringify({ success: true, result: {} }),
      };
    },
  };
  await executeCad(client, "surface.check", catalog["surface.check"]!.example, {
    doc: "GM08",
  });
  await executeCad(
    client,
    "surface.offset",
    catalog["surface.offset"]!.example,
    { doc: "GM08" },
  );
  assert.equal(requests[0]!.object.readOnly, true);
  assert.equal(requests[1]!.object.readOnly, false);
});

test("blocked native surface results lift the envelope and fail", async () => {
  const client = {
    callTool: async () => ({
      text:
        "FMCAD_RESULT " +
        JSON.stringify({
          success: true,
          operation: "surface.offset",
          result: {
            schemaVersion: 1,
            status: "blocked",
            warnings: ["offsetFeatures is not available in the installed SDK"],
            limitations: [],
          },
        }),
    }),
  };
  const out = await executeCad(
    client,
    "surface.offset",
    catalog["surface.offset"]!.example,
    { doc: "GM08" },
  );
  assert.equal(out.success, false);
  assert.equal(out.status, "blocked");
});

test("native handoff bundles the surface module and availability gates", () => {
  const script = buildCadScript(
    "surface.trim",
    catalog["surface.trim"]!.example,
    { doc: "GM08" },
  );
  assert.ok(script.includes("def _surface_open_profile"));
  assert.ok(script.includes("TrimFeatureInput.cancel"));
  assert.ok(script.includes("'surface.check': _surface_check"));
  assert.ok(script.includes("_surface_model_preflight"));
});
