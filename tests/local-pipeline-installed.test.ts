import { at, list, record, text } from "./integration/offline-cli";
import { createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync, execFileSync } from "node:child_process";

const sourceRoot = path.resolve(__dirname, "../..");
const load = createRequire(path.join(sourceRoot, "package.json"));
const python = process.env["FMCAD_LOCAL_TEST_PYTHON"] || "python3";
const available =
  spawnSync(
    python,
    [
      "-I",
      "-B",
      "-c",
      "import PIL,numpy,scipy,cairosvg,vtracer,shapely,cv2,black,pygments",
    ],
    { encoding: "utf8" },
  ).status === 0;
test(
  "installed readonly CLI executes actual image/reference pipelines without Fusion config",
  {
    skip:
      !available &&
      "Set FMCAD_LOCAL_TEST_PYTHON to an installed image-worker environment",
  },
  (t) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "fmcad local installed żółć "),
    );
    let installation: string | undefined = undefined;
    t.after(() => {
      if (installation) {
        fs.chmodSync(installation, 0o755);
        for (const entry of fs.readdirSync(installation, {
          recursive: true,
          withFileTypes: true,
        })) {
          if (entry.isDirectory())
            fs.chmodSync(path.join(entry.parentPath, entry.name), 0o755);
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    const packageArtifact = process.env["FMCAD_CI_PACKAGE_TARBALL"];
    const packageTarball = packageArtifact
      ? path.resolve(sourceRoot, packageArtifact)
      : path.join(
          root,
          text(
            record(
              list(
                JSON.parse(
                  execFileSync(
                    "npm",
                    [
                      "pack",
                      "--ignore-scripts",
                      "--json",
                      "--pack-destination",
                      root,
                    ],
                    {
                      cwd: sourceRoot,
                      encoding: "utf8",
                      maxBuffer: 16 * 1024 * 1024,
                    },
                  ),
                ),
              )[0],
            )["filename"],
          ),
        );
    assert.ok(fs.existsSync(packageTarball), "Prepared npm package is missing");
    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        root,
        "--ignore-scripts",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        packageTarball,
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    installation = path.join(root, "node_modules/fmcad");
    const runtime = path.join(installation, "dist");
    const adapters = load(
      path.join(runtime, "src/dist/config-platform"),
    ) as typeof import("../packages/node-adapters/src/config-platform");
    const runtimePaths = adapters.resolveRuntimePaths({
      anchor: path.join(runtime, "src/cli.js"),
    });
    const identity = record(
      JSON.parse(
        fs.readFileSync(path.join(runtime, "runtime-build.json"), "utf8"),
      ),
    );
    assert.equal(
      adapters.runtimeBuildIdentity(runtimePaths),
      identity["fingerprint"],
    );
    assert.ok(
      fs.existsSync(path.join(runtime, "src/dist/python/local-pipeline.js")),
    );
    assert.ok(
      fs.existsSync(
        path.join(runtime, "src/dist/core/application/local-pipeline.js"),
      ),
    );
    const before = fs.readdirSync(installation, { recursive: true }).sort();
    for (const entry of fs.readdirSync(installation, {
      recursive: true,
      withFileTypes: true,
    })) {
      fs.chmodSync(
        path.join(entry.parentPath, entry.name),
        entry.isDirectory() ? 0o555 : 0o444,
      );
    }
    fs.chmodSync(installation, 0o555);
    const home = path.join(root, "clean home"),
      cwd = path.join(root, "foreign cwd");
    fs.mkdirSync(home);
    fs.mkdirSync(cwd);
    const config = path.join(root, "invalid Fusion config.json");
    fs.writeFileSync(config, "this is deliberately not JSON");
    const env = {
      PATH: process.env["PATH"],
      HOME: home,
      FMCAD_PYTHON: python,
      FMCAD_CONFIG: config,
      FMCAD_BACKEND: "must-not-read",
    };
    const cli = path.join(runtime, "bin/fmcad.js");
    const run = (argv: string[]) => {
      const child = spawnSync(process.execPath, [cli, ...argv], {
        cwd,
        env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(child.status, 0, child.stderr);
      return record(JSON.parse(child.stdout));
    };
    const image = path.join(cwd, "source.png");
    const generated = spawnSync(
      python,
      [
        "-I",
        "-B",
        "-c",
        'from PIL import Image,ImageDraw; import sys; im=Image.new("RGB",(32,32),"white"); ImageDraw.Draw(im).rectangle((8,8,23,23),fill="black"); im.save(sys.argv[1])',
        image,
      ],
      { encoding: "utf8" },
    );
    assert.equal(generated.status, 0, generated.stderr);
    fs.writeFileSync(
      path.join(cwd, "palette.json"),
      JSON.stringify({
        background: "#ffffff",
        colors: [{ name: "ink", color: "#000000" }],
        rules: [{ color: "ink", ranges: { luma: [0, 50] } }],
      }),
    );
    assert.equal(
      at(
        run([
          "image",
          "trace",
          "--input",
          "source.png",
          "--out",
          "trace",
          "--palette",
          "palette.json",
          "--mode",
          "polygon",
        ]),
        "success",
      ),
      true,
    );
    assert.equal(
      at(
        run([
          "image",
          "optimize",
          "--input",
          "source.png",
          "--out",
          "optimize",
          "--palette",
          "palette.json",
          "--trials",
          "2",
          "--top-k",
          "1",
        ]),
        "success",
      ),
      true,
    );
    assert.equal(
      at(
        run([
          "image",
          "boundaries",
          "--svg",
          "trace/contours.svg",
          "--reference",
          "source.png",
          "--palette",
          "palette.json",
          "--out",
          "boundaries",
          "--scale",
          "1",
        ]),
        "result",
        "status",
      ),
      "inspected",
    );
    const request = (mode: string, value: Record<string, unknown>) => {
      const file = path.join(cwd, `${mode}.json`);
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, ...value }));
      return run(["reference", mode, "--file", file]);
    };
    const camera = {
      projection: "orthographic",
      orientation: "front",
      frame: "root",
    };
    const layout = request("layout", {
      original: { path: "source.png", status: "CONFIRMED", uncertaintyPx: 0 },
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
      out: "layout",
    });
    assert.equal(layout["success"], true);
    const calibration = request("calibrate", {
      layout: layout["reportPath"],
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
      out: "calibrate",
    });
    assert.equal(calibration["success"], true);
    const comparison = request("compare", {
      calibration: calibration["reportPath"],
      comparisons: [
        {
          view: "front",
          render: "source.png",
          camera,
          tolerancePx: 0,
          landmarks: [{ id: "corner", reference: [8, 8], render: [8, 8] }],
        },
      ],
      out: "compare",
    });
    assert.equal(comparison["success"], true);
    assert.equal(comparison["nativeAcceptance"], "notEvaluated");
    // Real formatter, not a fake interpreter: installed resources, foreign cwd,
    // read-only installation and no source execution or installation mutation.
    const source = path.join(cwd, "never execute.py");
    fs.writeFileSync(source, 'raise RuntimeError("must not run")\nx=1\n');
    const formatted = spawnSync(
      process.execPath,
      [
        "-e",
        `
    require(${JSON.stringify(path.join(runtime, "src/console-source.js"))}).openSource(
      {sourcePath:process.argv[1]}, {pythonPath:process.env["FMCAD_PYTHON"]}
    ).then(result=>process.stdout.write(JSON.stringify(result)));
  `,
        source,
      ],
      { cwd, env, encoding: "utf8" },
    );
    assert.equal(formatted.status, 0, formatted.stderr);
    const preview = record(JSON.parse(formatted.stdout));
    assert.equal(
      at(preview, "formatter", "applied"),
      true,
      String(at(preview, "formatter", "error")),
    );
    assert.match(text(preview["formatted"]), /x = 1/);
    assert.equal(
      fs.readFileSync(source, "utf8"),
      'raise RuntimeError("must not run")\nx=1\n',
    );

    // Private supervisor and callable protocol remain installation-local. They
    // are deliberately not exposed through a generic CLI module/function API.
    const assets = path.join(runtime, "assets");
    const supervised = spawnSync(
      python,
      [
        "-I",
        "-B",
        "-c",
        `
import inspect,json,sys
sys.path.append(${JSON.stringify(assets)})
from offline_execution import call_offline
print(json.dumps(call_offline('json','loads',['{"installed":true}'],log_parent=sys.argv[1])))
`,
        cwd,
      ],
      { cwd, env, encoding: "utf8" },
    );
    assert.equal(supervised.status, 0, supervised.stderr);
    assert.deepEqual(JSON.parse(supervised.stdout), { installed: true });
    for (const name of [
      "image_trace.py",
      "image_optimize.py",
      "image_boundaries.py",
      "reference_images.py",
    ]) {
      const invalid = spawnSync(python, ["-I", "-B", path.join(assets, name)], {
        cwd,
        env,
        input: "{} {}",
        encoding: "utf8",
      });
      assert.notEqual(invalid.status, 0, name);
      assert.equal(invalid.stdout, "", name);
    }
    for (const name of [
      "ui_dialog.ps1",
      "image_trace_detail_requirements.txt",
      "reference_images_requirements.txt",
    ])
      assert.ok(fs.existsSync(path.join(assets, name)), name);
    const fit = run([
      "fit",
      "stack",
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        identity: { model: "fixture", revision: "1" },
        frame: "datum:A",
        assumptions: ["Declared stack"],
        terms: [
          { id: "gap", sign: 1, nominal: "5 mm", minus: "1 mm", plus: "2 mm" },
        ],
        minimum: "3 mm",
      }),
    ]);
    assert.equal(at(fit, "result", "nominal", "value"), 0.005);
    assert.deepEqual(fs.readdirSync(home), []);
    assert.deepEqual(
      fs.readdirSync(installation, { recursive: true }).sort(),
      before,
    );
    assert.equal(
      adapters.runtimeBuildIdentity(runtimePaths),
      identity["fingerprint"],
    );
  },
);
