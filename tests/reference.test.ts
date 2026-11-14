import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import type { CliDependencies } from "../src/entrypoints/cli";
import { at, list, record, text } from "./integration/offline-cli";
const root = process.cwd();
const load = createRequire(__filename);
const { main } = load(
  path.join(root, "src/cli"),
) as typeof import("../src/entrypoints/cli");
const { catalog, validateCad, buildCadScript } = load(
  path.join(root, "src/cad"),
) as typeof import("../src/composition/cad-execution");
function example(operation: string) {
  const spec = catalog[operation];
  assert(spec, operation);
  return record(structuredClone(spec.example));
}
const python =
  process.env["FMCAD_REFERENCE_PYTHON"] || path.join(root, ".venv/bin/python");
const dependency = spawnSync(python, ["-B", "-c", "import PIL, numpy, scipy"]);
assert.equal(
  dependency.status,
  0,
  "Reference contracts require Pillow, NumPy and SciPy: " +
    String(dependency.stderr),
);
function harness() {
  const h: { out: string; err: string; deps: CliDependencies } = {
    out: "",
    err: "",
    deps: {},
  };
  h.deps = {
    stdout: {
      write: (v) => {
        h.out += v;
      },
    },
    stderr: {
      write: (v) => {
        h.err += v;
      },
    },
    loadConfig: () => assert.fail("GM05 must not load backend config"),
    createFmcad: () => assert.fail("GM05 must not connect to Fusion"),
    setExitCode: () => {},
  };
  return h;
}

test("GM05 methods, help, preview, schemas and existing image contract remain reachable", async () => {
  for (const mode of ["layout", "calibrate", "compare"]) {
    const spec = catalog["reference." + mode];
    assert(spec);
    assert.equal(spec.offline, true);
    assert.equal(spec.requiresDoc, false);
    validateCad("reference." + mode, spec.example);
    const h = harness();
    assert.equal(
      await main(
        [
          "reference",
          mode,
          "--data",
          JSON.stringify(spec.example),
          "--preview",
        ],
        h.deps,
      ),
      0,
    );
    assert.equal(at(JSON.parse(h.out), "state"), "input-validated-only");
    const help = harness();
    assert.equal(await main(["help", "reference", mode], help.deps), 0);
    assert.match(help.out, /Local Return Contract/);
    assert.match(help.out, /nativeAcceptance/);
  }
  validateCad("reference.image", example("reference.image"));
  validateCad("reference.image", { mode: "inspect", ref: { token: "canvas" } });
  assert.throws(
    () =>
      validateCad("reference.image", {
        mode: "inspect",
        ref: "canvas",
        length: "1 mm",
      }),
    /only mode\/ref/,
  );
  assert.throws(
    () => validateCad("reference.image", { mode: "calibrate", ref: "canvas" }),
    /requires segment/,
  );
  const script = buildCadScript(
    "reference.image",
    { mode: "inspect", ref: "canvas" },
    { doc: "Model" },
  );
  assert.match(script, /'reference\.image': _io_reference_image/);
  assert.match(script, /"operation": "reference\.image"/);
  assert.doesNotMatch(script, /import numpy|from PIL/);
});

test("GM05 real CLI pipeline processes actual synthetic files offline", async (t) => {
  const parent = path.join(root, ".test-artifacts");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "reference-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = path.join(dir, "source.png");
  const fixture = spawnSync(python, [
    "-B",
    "-c",
    'from PIL import Image; import sys; Image.new("RGB",(100,200),"white").save(sys.argv[1])',
    original,
  ]);
  assert.equal(fixture.status, 0);
  const layout = example("reference.layout");
  Object.assign(layout, {
    original: { path: original, status: "ESTIMATED", uncertaintyPx: 1 },
    out: path.join(dir, "layout"),
    python,
  });
  const req = path.join(dir, "request.json");
  fs.writeFileSync(req, JSON.stringify(layout));
  const h = harness();
  assert.equal(
    await main(["reference", "layout", "--file", req, "--json"], h.deps),
    0,
    h.err,
  );
  const report: unknown = JSON.parse(h.out);
  assert.equal(at(report, "operation"), "reference.layout");
  assert.equal(at(report, "documentIdentity"), null);
  assert.equal(at(report, "nativeAcceptance"), "notEvaluated");
  assert.deepEqual(
    fs.readFileSync(text(at(report, "result", "originalCopy", "path"))),
    fs.readFileSync(original),
  );
  const calibration = example("reference.calibrate");
  Object.assign(calibration, {
    layout: at(report, "reportPath"),
    out: path.join(dir, "calibration"),
    python,
  });
  const c = harness();
  assert.equal(
    await main(
      ["reference", "calibrate", "--data", JSON.stringify(calibration)],
      c.deps,
    ),
    0,
    c.err,
  );
  assert.equal(at(JSON.parse(c.out), "status"), "unknown");
  const compare = example("reference.compare");
  Object.assign(compare, {
    calibration: at(JSON.parse(c.out), "reportPath"),
    out: path.join(dir, "compare"),
    python,
  });
  record(list(compare["comparisons"])[0])["render"] = at(
    report,
    "result",
    "views",
    0,
    "path",
  );
  const d = harness();
  assert.equal(
    await main(
      ["reference", "compare", "--data", JSON.stringify(compare)],
      d.deps,
    ),
    0,
    d.err,
  );
  assert.equal(
    at(
      JSON.parse(d.out),
      "result",
      "comparisons",
      0,
      "metrics",
      0,
      "deviationPx",
    ),
    0,
  );
  assert.equal(
    at(
      JSON.parse(d.out),
      "result",
      "comparisons",
      0,
      "metrics",
      0,
      "projectedDeviationMm",
    ),
    null,
  );
  calibration["out"] = path.join(dir, "blocked");
  record(at(calibration, "dimension", "source"))["status"] = "OPEN";
  const blocked = harness();
  assert.equal(
    await main(
      ["reference", "calibrate", "--data", JSON.stringify(calibration)],
      blocked.deps,
    ),
    1,
  );
  assert.equal(at(JSON.parse(blocked.out), "status"), "blocked");
});

test("GM05 worker failures are local and do not publish outputs", async () => {
  const request = {
    ...example("reference.layout"),
    python,
    schemaVersion: 1,
    original: {
      path: "missing-gm05-image.png",
      status: "OPEN",
      uncertaintyPx: 0,
    },
  };
  const h = harness();
  assert.equal(
    await main(
      ["reference", "layout", "--data", JSON.stringify(request)],
      h.deps,
    ),
    1,
  );
  assert.match(h.err, /Local reference worker failed/);
  const invalid = harness();
  assert.equal(
    await main(
      [
        "reference",
        "layout",
        "--data",
        JSON.stringify({ ...request, schemaVersion: 2 }),
      ],
      invalid.deps,
    ),
    1,
  );
  assert.match(invalid.err, /schemaVersion/);
});
