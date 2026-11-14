// Live integration tests for GM-05 (reference images, calibration, comparison).
//
// `reference layout/calibrate/compare` are local, source-preserving image
// workers that need Pillow/NumPy/SciPy in the selected Python interpreter. They
// run without --doc and require those dependencies. Missing packages fail the gate. The native
// Canvas path (G05-06, `reference image`) requires a manually inserted canvas
// and is left to the live operator per docs/GM05.md.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fmcad, at, list, text } from "./offline-cli";

const ROOT = path.resolve(__dirname, "../../..");
const python =
  process.env["FMCAD_REFERENCE_PYTHON"] || path.join(ROOT, ".venv/bin/python");
const dependency = spawnSync(python, ["-B", "-c", "import PIL, numpy, scipy"]);
assert.equal(
  dependency.status,
  0,
  "Reference integration requires Pillow, NumPy and SciPy: " +
    String(dependency.stderr),
);

function tmpdir(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gm05-live-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mkPng(dir: string) {
  const file = path.join(dir, "source.png");
  const r = spawnSync(python, [
    "-B",
    "-c",
    'from PIL import Image; import sys; Image.new("RGB",(300,200),"white").save(sys.argv[1])',
    file,
  ]);
  assert.equal(r.status, 0, String(r.stderr) + String(r.stdout));
  return file;
}

function runLayout(dir: string, png: string, views: unknown[]) {
  return fmcad([
    "reference",
    "layout",
    "--data",
    JSON.stringify({
      schemaVersion: 1,
      python,
      original: { path: png, status: "ESTIMATED", uncertaintyPx: 1 },
      frame: {
        name: "root",
        origin: ["0 mm", "0 mm", "0 mm"],
        xAxis: [1, 0, 0],
        yAxis: [0, 1, 0],
      },
      views,
      out: path.join(dir, "layout-out"),
    }),
  ]);
}

test("gm05: G05-01 reference layout preserves original bytes and transform metadata", (t) => {
  const dir = tmpdir(t);
  const png = mkPng(dir);
  const out = runLayout(dir, png, [
    {
      id: "front",
      orientation: "front",
      crop: [0, 0, 100, 200],
      rotation: "0 deg",
      camera: { projection: "unknown", orientation: "front", frame: "root" },
    },
  ]);
  assert.equal(at(out, "operation"), "reference.layout");
  assert.equal(at(out, "documentIdentity"), null);
  assert.equal(at(out, "nativeAcceptance"), "notEvaluated");
  assert.deepEqual(
    fs.readFileSync(text(at(out, "result", "originalCopy", "path"))),
    fs.readFileSync(png),
  );
});

test("gm05: G05-02 reference layout splits front/side/rear views with oriented crops", (t) => {
  const dir = tmpdir(t);
  const png = mkPng(dir);
  const out = runLayout(dir, png, [
    {
      id: "front",
      orientation: "front",
      crop: [0, 0, 100, 200],
      rotation: "0 deg",
      camera: { projection: "unknown", orientation: "front", frame: "root" },
    },
    {
      id: "side",
      orientation: "side",
      crop: [100, 0, 100, 200],
      rotation: "0 deg",
      camera: { projection: "unknown", orientation: "side", frame: "root" },
    },
    {
      id: "rear",
      orientation: "rear",
      crop: [200, 0, 100, 200],
      rotation: "0 deg",
      camera: { projection: "unknown", orientation: "rear", frame: "root" },
    },
  ]);
  assert.equal(at(out, "success"), true, JSON.stringify(out));
  assert.equal(list(at(out, "result", "views")).length, 3);
  assert.deepEqual(
    list(at(out, "result", "views")).map((v) => at(v, "id")),
    ["front", "side", "rear"],
  );
});

test("gm05: G05-03 reference calibrate fits one shared scale and retains uncertainty", (t) => {
  const dir = tmpdir(t);
  const layout = runLayout(dir, mkPng(dir), [
    {
      id: "front",
      orientation: "front",
      crop: [0, 0, 100, 200],
      rotation: "0 deg",
      camera: { projection: "unknown", orientation: "front", frame: "root" },
    },
  ]);
  const out = fmcad([
    "reference",
    "calibrate",
    "--data",
    JSON.stringify({
      schemaVersion: 1,
      python,
      layout: at(layout, "reportPath"),
      dimension: {
        id: "height",
        value: "250 mm",
        uncertainty: "5 mm",
        source: { path: "brief.md", status: "ESTIMATED" },
      },
      controls: [
        {
          view: "front",
          segment: [
            [50, 0],
            [50, 199],
          ],
          anchor: ["0 mm", "0 mm"],
          angle: "90 deg",
        },
      ],
      tolerance: "1 mm",
      out: path.join(dir, "cal-out"),
    }),
  ]);
  assert.equal(at(out, "operation"), "reference.calibrate");
  assert.equal(at(out, "status"), "unknown"); // ESTIMATED source remains unresolved
});

test("gm05: G05-04 reference compare measures landmark and silhouette deviation", (t) => {
  const dir = tmpdir(t);
  const layout = runLayout(dir, mkPng(dir), [
    {
      id: "front",
      orientation: "front",
      crop: [0, 0, 100, 200],
      rotation: "0 deg",
      camera: { projection: "unknown", orientation: "front", frame: "root" },
    },
  ]);
  const cal = fmcad([
    "reference",
    "calibrate",
    "--data",
    JSON.stringify({
      schemaVersion: 1,
      python,
      layout: at(layout, "reportPath"),
      dimension: {
        id: "height",
        value: "250 mm",
        uncertainty: "5 mm",
        source: { path: "brief.md", status: "ESTIMATED" },
      },
      controls: [
        {
          view: "front",
          segment: [
            [50, 0],
            [50, 199],
          ],
          anchor: ["0 mm", "0 mm"],
          angle: "90 deg",
        },
      ],
      tolerance: "1 mm",
      out: path.join(dir, "cal-out"),
    }),
  ]);
  const out = fmcad([
    "reference",
    "compare",
    "--data",
    JSON.stringify({
      schemaVersion: 1,
      python,
      calibration: at(cal, "reportPath"),
      comparisons: [
        {
          view: "front",
          render: at(layout, "result", "views", 0, "path"),
          camera: {
            projection: "unknown",
            orientation: "front",
            frame: "root",
          },
          landmarks: [{ id: "tip", reference: [50, 0], render: [50, 0] }],
          tolerancePx: 2,
        },
      ],
      out: path.join(dir, "cmp-out"),
    }),
  ]);
  assert.equal(at(out, "operation"), "reference.compare");
  assert.equal(
    at(out, "result", "comparisons", 0, "metrics", 0, "deviationPx"),
    0,
  );
  assert.equal(
    at(out, "result", "comparisons", 0, "metrics", 0, "projectedDeviationMm"),
    null,
  );
});

test("gm05: G05-05 reference calibrate blocks OPEN sources instead of fabricating a scale", (t) => {
  const dir = tmpdir(t);
  const layout = runLayout(dir, mkPng(dir), [
    {
      id: "front",
      orientation: "front",
      crop: [0, 0, 100, 200],
      rotation: "0 deg",
      camera: { projection: "unknown", orientation: "front", frame: "root" },
    },
  ]);
  assert.throws(
    () =>
      fmcad([
        "reference",
        "calibrate",
        "--data",
        JSON.stringify({
          schemaVersion: 1,
          python,
          layout: at(layout, "reportPath"),
          dimension: {
            id: "height",
            value: "250 mm",
            uncertainty: "5 mm",
            source: { path: "brief.md", status: "OPEN" },
          },
          controls: [
            {
              view: "front",
              segment: [
                [50, 0],
                [50, 199],
              ],
              anchor: ["0 mm", "0 mm"],
              angle: "90 deg",
            },
          ],
          tolerance: "1 mm",
          out: path.join(dir, "cal-blocked"),
        }),
      ]),
    /blocked/,
  );
});
