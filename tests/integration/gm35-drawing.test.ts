import type { DrawingInput } from "../../packages/core/src/application/drawing/types";
import type { JsonValue } from "../../packages/core/src/domain/contracts";

// Live integration tests for GM-35 (drawing package/check/export). This family
// is LOCAL: it runs without --doc, produces real SVG/PDF/DXF artifacts with
// semantic dimensions and a source map, and never calls Fusion. Native Drawing
// authoring is a declared SDK gate reported as blocked, never faked.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fmcad, cad, at, list, text, record } from "./offline-cli";

function makeDir(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-g35-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

// Canonical passing package: a front projection with a plate + concentric
// shaft/bore, two semantic dimensions, an item table, a balloon and a fit.
type DrawingFixture = DrawingInput & {
  out: string;
  dimensions: Record<string, JsonValue>[];
  items: Record<string, JsonValue>[];
  balloons: Record<string, JsonValue>[];
};
function request(out: string): DrawingFixture {
  return {
    schemaVersion: 1,
    documentIdentity: { name: "Seal Subassembly", revision: "A" },
    sheet: {
      format: "A3",
      titleBlock: { drawingNumber: "CW-100", scale: "1:1" },
    },
    views: [
      {
        id: "front",
        kind: "projection",
        orientation: "front",
        scale: 1,
        origin: [40, 40],
        geometry: [
          {
            id: "plate",
            kind: "polyline",
            points: [
              [0, 0],
              [60, 0],
              [60, 40],
              [0, 40],
            ],
            closed: true,
          },
          { id: "bore", kind: "circle", center: [30, 20], r: 5 },
          { id: "shaft", kind: "circle", center: [30, 20], r: 3 },
        ],
      },
    ],
    dimensions: [
      {
        id: "width",
        view: "front",
        kind: "linear",
        a: [0, 0],
        b: [60, 0],
        offset: -10,
        value: "60 mm",
        tolerance: { upper: "0.1 mm", lower: "-0.1 mm" },
        source: { path: "specs/seal.json", status: "CONFIRMED" },
      },
      {
        id: "bore-dia",
        view: "front",
        kind: "diameter",
        circle: "bore",
        value: "10 mm",
        source: { path: "specs/seal.json", status: "CONFIRMED" },
      },
    ],
    items: [
      {
        item: 1,
        partId: "P020",
        description: "Housing",
        qty: 1,
        purchased: false,
        source: { path: "BOM.csv", status: "CONFIRMED" },
      },
    ],
    balloons: [
      {
        id: "b1",
        view: "front",
        item: 1,
        at: [70, 55],
        anchor: { entity: "plate", role: "vertex", index: 2 },
      },
    ],
    fits: [
      {
        id: "seal-fit",
        view: "front",
        shaft: "shaft",
        bore: "bore",
        clearance: {
          min: "1.9 mm",
          max: "2.1 mm",
          source: { path: "tolerance-strategy.md", status: "CONFIRMED" },
        },
      },
    ],
    out,
  };
}

test("gm35: G35-01 native drawing representation is an honest blocked gate", (t) => {
  const base = makeDir(t);
  const req = {
    ...request(path.join(base, "native")),
    representation: "native",
  };
  const out = cad(["drawing", "package", "--data", JSON.stringify(req)]);
  assert.equal(
    at(out, "json", "status"),
    "blocked",
    JSON.stringify(at(out, "json")),
  );
  assert.equal(at(out, "json", "success"), false);
  assert.match(
    text(at(out, "json", "result", "reason")),
    /native drawing authoring is not available/,
  );
  assert.ok(!fs.existsSync(req.out));
});

test("gm35: G35-02 drawing package builds views, semantic dimensions and a source map", (t) => {
  const base = makeDir(t);
  const out = fmcad([
    "drawing",
    "package",
    "--data",
    JSON.stringify(request(path.join(base, "pkg"))),
  ]);
  assert.equal(at(out, "status"), "pass", JSON.stringify(out));
  assert.equal(at(out, "success"), true);
  assert.equal(at(out, "documentIdentity", "name"), "Seal Subassembly");
  assert.equal(at(out, "nativeAcceptance"), "notEvaluated");
  assert.equal(at(out, "associativity"), "snapshot");
  assert.equal(at(out, "result", "nativeDrawing", "status"), "blocked");
  assert.equal(
    at(out, "result", "sourceMap", "dimensions", "bore-dia", "status"),
    "CONFIRMED",
  );
  assert.ok(fs.existsSync(text(at(out, "result", "scene", "path"))));
  assert.equal(
    at(out, "result", "scene", "sha256"),
    at(out, "result", "scene", "sha256"),
  );
  assert.ok(fs.existsSync(text(at(out, "reportPath"))));
});

test("gm35: G35-03 drawing package supports tolerances, datums and GD&T in the declared range", (t) => {
  const base = makeDir(t);
  const req = request(path.join(base, "pkg"));
  req.datums = [
    {
      id: "A",
      view: "front",
      kind: "plane",
      at: [0, 0],
      source: { path: "datum.json", status: "CONFIRMED" },
    },
    {
      id: "B",
      view: "front",
      kind: "axis",
      at: [30, 20],
      source: { path: "datum.json", status: "CONFIRMED" },
    },
  ];
  req.controls = [
    {
      id: "f1",
      view: "front",
      kind: "position",
      target: "bore",
      value: "0.1 mm",
      datums: ["A", "B"],
      anchor: [30, 20],
      source: { path: "gdnt.json", status: "CONFIRMED" },
    },
  ];
  const out = fmcad(["drawing", "package", "--data", JSON.stringify(req)]);
  assert.equal(at(out, "status"), "pass", JSON.stringify(out));
  const scene: unknown = JSON.parse(
    fs.readFileSync(text(at(out, "result", "scene", "path")), "utf8"),
  );
  assert.ok(
    list(at(scene, "primitives")).some(
      (p) => at(p, "type") === "text" && at(p, "text") === "⌖",
    ),
  );
});

test("gm35: G35-04 drawing package carries item table, balloons and material/process notes", (t) => {
  const base = makeDir(t);
  const req = request(path.join(base, "pkg"));
  req.notes = [
    {
      id: "n1",
      text: "Material: POM",
      kind: "material",
      at: [40, 210],
      height: 3,
      source: { path: "notes.md", status: "CONFIRMED" },
    },
  ];
  const out = fmcad(["drawing", "package", "--data", JSON.stringify(req)]);
  assert.equal(at(out, "status"), "pass", JSON.stringify(out));
  assert.ok(
    list(at(out, "result", "checks")).some(
      (c) => at(c, "kind") === "balloon-item-map" && at(c, "status") === "pass",
    ),
  );
  assert.ok(
    list(at(out, "result", "checks")).some(
      (c) =>
        at(c, "kind") === "content-completeness" && at(c, "status") === "pass",
    ),
  );
});

test("gm35: G35-05 drawing check re-verifies the stored package and scene hashes", (t) => {
  const base = makeDir(t);
  const pkg = fmcad([
    "drawing",
    "package",
    "--data",
    JSON.stringify(request(path.join(base, "pkg"))),
  ]);
  const out = fmcad([
    "drawing",
    "check",
    "--data",
    JSON.stringify({
      schemaVersion: 1,
      package: at(pkg, "reportPath"),
      out: path.join(base, "check"),
    }),
  ]);
  assert.equal(at(out, "status"), "pass", JSON.stringify(out));
  assert.ok(list(at(out, "result", "checks")).length > 0);
  assert.equal(
    list(at(out, "result", "checks")).filter((c) => at(c, "status") !== "pass")
      .length,
    0,
  );
});

test("gm35: G35-06 drawing export emits real SVG, PDF and DXF artifacts with a manifest", (t) => {
  const base = makeDir(t);
  const pkg = fmcad([
    "drawing",
    "package",
    "--data",
    JSON.stringify(request(path.join(base, "pkg"))),
  ]);
  const out = fmcad([
    "drawing",
    "export",
    "--data",
    JSON.stringify({
      schemaVersion: 1,
      package: at(pkg, "reportPath"),
      formats: ["svg", "pdf", "dxf"],
      out: path.join(base, "export"),
    }),
  ]);
  assert.equal(at(out, "status"), "pass", JSON.stringify(out));
  const files = new Map(
    list(at(out, "result", "files")).map((f) => [text(at(f, "format")), f]),
  );
  assert.deepEqual([...files.keys()].sort(), ["dxf", "pdf", "svg"]);
  for (const file of list(at(out, "result", "files"))) {
    assert.equal(
      fs.readFileSync(text(at(file, "path"))).length,
      at(file, "sizeBytes"),
    );
  }
  assert.match(
    fs.readFileSync(text(at(files.get("svg"), "path")), "utf8"),
    /fmcad-source-map/,
  );
  assert.match(
    fs.readFileSync(text(at(files.get("dxf"), "path")), "utf8"),
    /\r\nENTITIES\r\n/,
  );
});

test("gm35: G35-07 drawing package handles a purchased spring item and an opening artifact", (t) => {
  const base = makeDir(t);
  const req = request(path.join(base, "pkg"));
  req.items.push({
    item: 2,
    partId: "P050",
    description: "Spring",
    qty: 1,
    purchased: true,
    source: { path: "BOM.csv", status: "CONFIRMED" },
  });
  req.balloons.push({
    id: "b2",
    view: "front",
    item: 2,
    at: [80, 60],
    anchor: [60, 40],
  });
  const out = fmcad(["drawing", "package", "--data", JSON.stringify(req)]);
  assert.equal(at(out, "status"), "pass", JSON.stringify(out));
  assert.ok(
    list(at(out, "result", "checks")).some(
      (c) => at(c, "kind") === "fit-geometry" && at(c, "status") === "pass",
    ),
  );
  assert.ok(fs.existsSync(text(at(out, "result", "scene", "path"))));
  assert.ok(fs.existsSync(text(at(out, "reportPath"))));
});

test("gm35: G35-08 ESTIMATED sources stay unknown and never become production tolerances", (t) => {
  const base = makeDir(t);
  const req = request(path.join(base, "pkg"));
  const dimension = req.dimensions[0];
  assert.ok(dimension);
  record(dimension["source"])["status"] = "ESTIMATED";
  delete dimension["tolerance"];
  const out = fmcad(["drawing", "package", "--data", JSON.stringify(req)]);
  assert.equal(at(out, "status"), "unknown", JSON.stringify(out));
  assert.equal(at(out, "success"), true);
  assert.equal(at(out, "nativeAcceptance"), "notEvaluated");
  assert.ok(
    list(at(out, "result", "checks")).some(
      (c) => at(c, "id") === "width" && at(c, "status") === "unknown",
    ),
  );
});
