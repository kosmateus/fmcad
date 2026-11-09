import type {
  LocalWorkerPort,
  LocalPipelineFiles,
} from "../packages/core/src/ports/local-pipeline";
import type { DataImportFiles } from "../packages/core/src/ports/data-import-files";
import { at, record } from "./integration/offline-cli";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { runEngineering } = load(
  "./packages/core/dist/application/engineering",
) as typeof import("../packages/core/src/application/engineering");
const { hash } = load(
  "./packages/core/dist/domain/engineering/common",
) as typeof import("../packages/core/src/domain/engineering/common");
const { sha256 } = load(
  "./packages/core/dist/domain/engineering/sha256",
) as typeof import("../packages/core/src/domain/engineering/sha256");
const { parseImageArguments, planImage, planReference } = load(
  "./packages/core/dist/domain/local-pipeline-plan",
) as typeof import("../packages/core/src/domain/local-pipeline-plan");
const { runImagePipeline, runReferencePipeline } = load(
  "./packages/core/dist/application/local-pipeline",
) as typeof import("../packages/core/src/application/local-pipeline");
const { createLocalWorker } = load(
  "./packages/node-adapters/dist/python/local-pipeline",
) as typeof import("../packages/node-adapters/src/python/local-pipeline");

const base = {
  schemaVersion: 1,
  identity: { model: "fixture", revision: "1" },
  frame: "datum:A",
  assumptions: ["Explicit inputs only"],
};
const fit = {
  ...base,
  terms: [{ id: "gap", sign: 1, nominal: "5 mm", minus: "1 mm", plus: "2 mm" }],
  minimum: "3 mm",
};

test("engineering deterministic budget/clock, SI, provenance and immutable input", () => {
  const input = structuredClone(fit),
    original = structuredClone(input);
  const result = runEngineering("fit.stack", input);
  assert.equal(at(result, "result", "nominal", "value"), 0.005);
  assert.equal(at(result, "result", "nominal", "unit"), "m");
  for (let i = 0; i < 10; i++)
    assert.deepEqual(runEngineering("fit.stack", input), result);
  assert.deepEqual(input, original);
  assert.equal(
    at(result, "provenance", "cacheIdentity"),
    hash({ operation: "fit.stack", method: "local-analytic-v1", input }),
  );
  assert.throws(
    () =>
      runEngineering("fit.stack", {
        ...input,
        terms: [...input.terms, { ...input.terms[0], id: "two" }],
        budget: { maxEvaluations: 1, timeMs: 100 },
      }),
    /budget exceeded/,
  );
  let now = 0;
  assert.throws(
    () =>
      runEngineering("fit.stack", input, {
        clock: { now: () => (now += 1001) },
      }),
    /budget exceeded/,
  );
  assert.deepEqual(
    runEngineering("fit.stack", input, { clock: { now: () => 17 } }),
    result,
  );
  assert.throws(
    () =>
      runEngineering("fit.stack", input, { clock: { now: () => (now -= 1) } }),
    /monotonic/,
  );
  assert.throws(
    () => runEngineering("fit.stack", { ...input, surprise: true }),
    /unknown field/,
  );
  assert.throws(
    () =>
      runEngineering("fit.stack", {
        ...input,
        terms: [{ ...input.terms[0], nominal: "1e999 mm" }],
      }),
    /finite/,
  );
  assert.throws(
    () =>
      runEngineering("fit.stack", {
        ...input,
        terms: [{ ...input.terms[0], nominal: "2 kg" }],
      }),
    /length units/,
  );
  const partial = runEngineering("fit.stack", {
    ...input,
    terms: [
      {
        ...input.terms[0],
        nominal: { value: null, status: "OPEN", source: "unmeasured" },
      },
    ],
  });
  assert.equal(partial.status, "unknown");
  assert.equal(at(partial, "result", "nominal"), null);
  assert.equal(at(partial, "provenance", "status"), "OPEN");
});

test("host-independent provenance SHA256 matches Node UTF-8 bytes including boundaries", () => {
  for (const input of [
    "",
    "abc",
    "ą中😀",
    "\ud800",
    "x".repeat(55),
    "x".repeat(56),
    "x".repeat(64),
    "x".repeat(10000),
  ]) {
    assert.equal(
      sha256(input),
      crypto.createHash("sha256").update(input).digest("hex"),
    );
  }
});

test("partial mass data never becomes a numeric torque or a recovered tensor", () => {
  const v = { x: "0 m", y: "0 m", z: "0 m" };
  const tensor = {
    ixx: "0 kg*m2",
    iyy: "0 kg*m2",
    izz: "0 kg*m2",
    ixy: "0 kg*m2",
    ixz: "0 kg*m2",
    iyz: "0 kg*m2",
  };
  const input: {
    items: {
      id: string;
      mass: string;
      cg: typeof v;
      placement: typeof v;
      inertia?: typeof tensor;
    }[];
    efficiency?: null;
    [key: string]: unknown;
  } = {
    ...base,
    items: [
      {
        id: "one",
        mass: "1 kg",
        cg: v,
        placement: { ...v, x: "1 m" },
        inertia: tensor,
      },
    ],
    axis: { pivot: v, direction: { x: 0, y: 0, z: 1 } },
    gravity: { direction: { x: 0, y: -1, z: 0 }, magnitude: "10 m/s2" },
    friction: "1 N*m",
    efficiency: null,
  };
  const partial = runEngineering("load.axis", input);
  assert.equal(partial.status, "unknown");
  assert.equal(at(partial, "result", "requiredTorque"), null);
  delete input.efficiency;
  input.items.unshift({
    id: "missing-tensor",
    mass: "1 kg",
    cg: v,
    placement: { ...v, x: "1 m" },
  });
  const noTensor = runEngineering("load.axis", input);
  assert.equal(noTensor.status, "unknown");
  assert.equal(at(noTensor, "result", "inertiaAboutAxis"), null);
});

test("image plan pure validation and usecase do not start worker on invalid input", async () => {
  let starts = 0,
    reads = 0;
  const worker: LocalWorkerPort = {
    run: async (plan) => {
      starts++;
      return {
        code: 0,
        signal: null,
        stdout: JSON.stringify(plan.request),
        stderr: "",
      };
    },
  };
  const files: LocalPipelineFiles = {
    resolve: (value) => `/fixture/${value}`,
    readText: () => {
      reads++;
      return '{"input":"r.png","out":"new"}';
    },
  };
  await assert.rejects(
    () => runImagePipeline("trace", ["--doc", "Fusion"], files, worker),
    /unknown option/,
  );
  assert.equal(starts, 0);
  assert.equal(reads, 0);
  const result = await runImagePipeline(
    "trace",
    ["--file", "input.json", "--mirror-x", "true"],
    files,
    worker,
  );
  assert.deepEqual(JSON.parse(result.stdout), {
    input: "/fixture/r.png",
    out: "/fixture/new",
    mirrorX: true,
  });
  assert.equal(starts, 1);
  assert.equal(reads, 1);
  assert.throws(
    () =>
      planImage(
        parseImageArguments("boundaries", ["--file", "request.json"]),
        '{"svg":"a","svg":"b"}',
      ),
    /Duplicate image boundaries input/,
  );
  assert.throws(
    () =>
      planImage(
        parseImageArguments("trace", ["--input", "a", "--out", "b"]),
        '{"input":"c"}',
      ),
    /Duplicate image trace input/,
  );
  assert.throws(
    () => planReference("reference.layout", { python: "", out: "new" }),
    /local executable/,
  );
  assert.equal(starts, 1);
});

test("reference usecase preserves worker errors and JSON result", async () => {
  const result = {
    success: true,
    status: "unknown",
    provenance: { status: "OPEN" },
    nativeAcceptance: "notEvaluated",
  };
  let starts = 0;
  assert.deepEqual(
    await runReferencePipeline(
      "reference.layout",
      { schemaVersion: 1 },
      {
        run: async (plan) => {
          starts++;
          assert.equal(plan.args[0], "reference.layout");
          return {
            code: 0,
            signal: null,
            stdout: JSON.stringify(result),
            stderr: "",
          };
        },
      },
    ),
    result,
  );
  assert.equal(starts, 1);
  await assert.rejects(
    () =>
      runReferencePipeline(
        "reference.layout",
        {},
        {
          run: async () => ({
            code: 1,
            signal: null,
            stdout: "",
            stderr: "source mismatch",
          }),
        },
      ),
    /source mismatch/,
  );
});

test("data-import planner uses injected source snapshots and never calls local FS or transport", () => {
  const { prepare } = load(
    "./src/data-import",
  ) as typeof import("../src/composition/library-data-import");
  let snapshots = 0,
    stats = 0;
  const source = JSON.stringify([
    {
      name: "wall",
      expression: "2 mm",
      unit: "mm",
      status: "CONFIRMED",
      source: "fixture",
    },
  ]);
  const files: DataImportFiles = {
    cwd: () => "/virtual",
    isAbsolute: (value) => value.startsWith("/"),
    resolve: (base, value) => base + "/" + value,
    extension: (value) => path.extname(value),
    exists: () => true,
    stat: () => {
      stats++;
      return { regular: true, size: source.length };
    },
    snapshot: () => {
      snapshots++;
      return {
        text: source,
        sha256: crypto.createHash("sha256").update(source).digest("hex"),
      };
    },
  };
  const plan = prepare(
    "param.import",
    { version: 1, owner: "fixture", revision: "r1", source: "params.json" },
    files,
  );
  assert.equal(at(plan, "provenance", "path"), "/virtual/params.json");
  assert.equal(snapshots, 1);
  assert.equal(stats, 1);
  assert.throws(
    () =>
      prepare(
        "param.import",
        { version: 1, owner: "fixture", revision: "r1", source: "large.json" },
        {
          ...files,
          stat: () => ({ regular: true, size: 32 * 1024 * 1024 + 1 }),
        },
      ),
    /32 MiB/,
  );
  assert.equal(snapshots, 1);
});

// Set FMCAD_LOCAL_TEST_PYTHON to an existing user-owned environment. This is not
// a fake interpreter or mocked Python module; missing dependencies are explicit.
const python = process.env["FMCAD_LOCAL_TEST_PYTHON"] || "python3";
const available =
  spawnSync(
    python,
    ["-c", "import PIL,numpy,scipy,cairosvg,vtracer,shapely,cv2"],
    { encoding: "utf8" },
  ).status === 0;
test(
  "real Python workers process raster trace, optimization, boundaries and reference source chain",
  {
    skip:
      !available &&
      "Set FMCAD_LOCAL_TEST_PYTHON to an installed image-worker environment",
  },
  async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "fmcad-pipeline-"),
    );
    let starts = 0;
    const adapter = createLocalWorker({
      spawn: (executable, args, options) => {
        starts++;
        assert.equal(options.stdio, "pipe");
        return spawn(executable, args, { ...options, stdio: "pipe" });
      },
      resolveWorker: (name) => {
        return path.join(
          root,
          "assets",
          {
            "image-trace": "image_trace.py",
            "image-optimize": "image_optimize.py",
            "image-boundaries": "image_boundaries.py",
            reference: "reference_images.py",
          }[name],
        );
      },
    });
    const image = path.join(directory, "source.png"),
      palette = path.join(directory, "palette.json");
    const generated = spawnSync(
      python,
      [
        "-c",
        'from PIL import Image,ImageDraw; import sys; im=Image.new("RGB",(32,32),"white"); ImageDraw.Draw(im).rectangle((8,8,23,23),fill="black"); im.save(sys.argv[1])',
        image,
      ],
      { encoding: "utf8" },
    );
    assert.equal(generated.status, 0, generated.stderr);
    await fs.writeFile(
      palette,
      JSON.stringify({
        background: "#ffffff",
        colors: [{ name: "ink", color: "#000000" }],
        rules: [{ color: "ink", ranges: { luma: [0, 50] } }],
      }),
    );
    const files: LocalPipelineFiles = {
      resolve: (value) => path.resolve(value),
      readText: (value) => fs.readFile(value, "utf8"),
    };
    try {
      const trace = await runImagePipeline(
        "trace",
        [
          "--input",
          image,
          "--out",
          path.join(directory, "trace"),
          "--palette",
          palette,
          "--mode",
          "polygon",
          "--python",
          python,
        ],
        files,
        adapter,
      );
      assert.equal(trace.code, 0, trace.stderr);
      assert.equal(record(JSON.parse(trace.stdout))["success"], true);
      const optimize = await runImagePipeline(
        "optimize",
        [
          "--input",
          image,
          "--out",
          path.join(directory, "optimize"),
          "--palette",
          palette,
          "--trials",
          "2",
          "--top-k",
          "1",
          "--python",
          python,
        ],
        files,
        adapter,
      );
      assert.equal(optimize.code, 0, optimize.stderr);
      assert.equal(record(JSON.parse(optimize.stdout))["success"], true);
      const boundaries = await runImagePipeline(
        "boundaries",
        [
          "--svg",
          path.join(directory, "trace", "contours.svg"),
          "--reference",
          image,
          "--palette",
          palette,
          "--out",
          path.join(directory, "boundaries"),
          "--scale",
          "1",
          "--python",
          python,
        ],
        files,
        adapter,
      );
      assert.equal(boundaries.code, 0, boundaries.stderr);
      assert.equal(
        at(JSON.parse(boundaries.stdout), "result", "status"),
        "inspected",
      );
      const camera = {
        projection: "orthographic",
        orientation: "front",
        frame: "root",
      };
      const layout = await runReferencePipeline(
        "reference.layout",
        {
          schemaVersion: 1,
          python,
          original: { path: image, status: "CONFIRMED", uncertaintyPx: 0 },
          frame: {
            name: "root",
            origin: ["0 mm", "0 mm", "0 mm"],
            xAxis: [1, 0, 0],
            yAxis: [0, 1, 0],
          },
          views: [
            {
              id: "front",
              orientation: "front",
              crop: [0, 0, 32, 32],
              rotation: "0 deg",
              camera,
            },
          ],
          out: path.join(directory, "layout"),
        },
        adapter,
      );
      assert.equal(at(layout, "success"), true);
      const calibration = await runReferencePipeline(
        "reference.calibrate",
        {
          schemaVersion: 1,
          python,
          layout: at(layout, "reportPath"),
          dimension: {
            id: "width",
            value: "16 mm",
            uncertainty: "0 mm",
            source: { path: "fixture", status: "CONFIRMED" },
          },
          controls: [
            {
              view: "front",
              segment: [
                [8, 8],
                [24, 8],
              ],
              anchor: ["0 mm", "0 mm"],
              angle: "0 deg",
            },
          ],
          tolerance: "0.01 mm",
          out: path.join(directory, "calibrate"),
        },
        adapter,
      );
      assert.equal(at(calibration, "success"), true);
      const comparison = await runReferencePipeline(
        "reference.compare",
        {
          schemaVersion: 1,
          python,
          calibration: at(calibration, "reportPath"),
          comparisons: [
            {
              view: "front",
              render: image,
              camera,
              tolerancePx: 0,
              landmarks: [{ id: "corner", reference: [8, 8], render: [8, 8] }],
            },
          ],
          out: path.join(directory, "compare"),
        },
        adapter,
      );
      assert.equal(at(comparison, "success"), true);
      assert.equal(at(comparison, "nativeAcceptance"), "notEvaluated");
      assert.equal(starts, 6);
      // Real-worker semantic error: nonfinite input never creates an output dir.
      const invalidOut = path.join(directory, "invalid");
      const invalid = await runImagePipeline(
        "trace",
        [
          "--input",
          image,
          "--out",
          invalidOut,
          "--blur-sigma",
          "1e999",
          "--python",
          python,
        ],
        files,
        adapter,
      );
      assert.equal(invalid.code, 1);
      assert.match(invalid.stderr, /finite|number/);
      await assert.rejects(() => fs.stat(invalidOut), { code: "ENOENT" });
      assert.equal(starts, 7);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
