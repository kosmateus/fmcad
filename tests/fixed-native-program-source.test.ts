import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { test } from "node:test";
import { asRecord, type JsonRecord } from "./live-import-receipts.js";

interface PreparedPlan extends JsonRecord {
  result: JsonRecord;
  digest: string;
  unresolved: unknown[];
}
interface DataImportModule {
  prepare(operation: string, data: JsonRecord): PreparedPlan;
}
interface SketchCasesModule {
  SKETCH_CASES: string[];
}

const projectRoot = path.resolve(__dirname, "..", "..");
const runtimeRequire = createRequire(__filename);
const assets = path.join(projectRoot, "assets/native-qualification");

function readManifest(file: string): JsonRecord {
  return asRecord(
    JSON.parse(fs.readFileSync(file, "utf8")) as unknown,
    `Manifest ${file}`,
  );
}

function assertPythonImports(file: string): void {
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      'import runpy,sys; value=runpy.run_path(sys.argv[1]); assert callable(value["run"])',
      file,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

test("fixed native source is a standalone Python module without SDK or stub-only runtime imports", () => {
  assertPythonImports(path.join(assets, "containment.py"));
});

test("fixed GM12 program pins only the four recipe/engineering methods and audits an unchanged scratch", () => {
  const file = path.join(assets, "gm12-spring.py");
  assertPythonImports(file);
  const source = fs.readFileSync(file, "utf8");
  for (const operation of [
    "curve.helix",
    "shape.spring",
    "spring.evaluate",
    "spring.configure",
  ])
    assert.ok(source.includes(`'${operation}'`), operation);
  assert.match(
    source,
    /for operation in operations:\s+results\[operation\] = _gm12_call\(operation, inputs\[operation\]\)/,
  );
  assert.match(source, /before = _gm12_call\('document\.status'/);
  assert.match(source, /after = _gm12_call\('document\.status'/);
  assert.match(source, /design_before == design_after/);
  assert.match(source, /'nativeGeometry': False/);
  assert.doesNotMatch(source, /documents\.add|\.close\(|\.saveAs\(|\.save\(/);
  const manifest = readManifest(path.join(assets, "gm12-spring-program.json"));
  assert.equal(manifest["fixtureId"], "gm12-spring-program-v1");
  assert.deepEqual(manifest["argumentKeys"], [
    "approved",
    "creationId",
    "expectedFusionVersion",
    "fixturePrefix",
  ]);
  assert.equal(manifest["callerCleanupRequired"], false);
});

test("fixed GM07 program pins existing curve methods and exact cleanup scope", () => {
  const file = path.join(assets, "gm07-curves.py");
  assertPythonImports(file);
  const source = fs.readFileSync(file, "utf8");
  for (const operation of [
    "sketch.create",
    "sketch.inspect",
    "sketch.profile-file",
    "curve.fit",
    "curve.inspect",
    "curve.offset",
    "curve.offset-edit",
  ])
    assert.ok(source.includes(`'${operation}'`), operation);
  assert.match(
    source,
    /_gm07_profile_data\(sketch_name, 'live-gm07-' \+ creation_id\)/,
  );
  assert.match(source, /'nativeGeometry': True/);
  assert.match(
    source,
    /owner must close and restore this exact unsaved document/,
  );
  assert.doesNotMatch(
    source,
    /fusion_mcp_execute|documents\.add|\.saveAs\(|\.save\(/,
  );
  const manifest = readManifest(path.join(assets, "gm07-curves-program.json"));
  assert.equal(manifest["fixtureId"], "gm07-curves-program-v1");
  assert.equal(manifest["callerCleanupRequired"], true);
});

test("fixed data-import source pins existing handlers and owned file cleanup", () => {
  const file = path.join(assets, "data-import.py");
  assertPythonImports(file);
  const source = fs.readFileSync(file, "utf8");
  for (const operation of [
    "param.import",
    "catalog.import",
    "placement.import",
    "cots.replace",
  ])
    assert.ok(source.includes(`'${operation}'`), operation);
  assert.match(
    source,
    /_di_cleanup\(artifacts, artifact_directory, owns_directory\)/,
  );
  assert.match(source, /modelChangedByFixture/);
  assert.match(source, /material remains explicitly unknown/);
  assert.match(
    source,
    /Expected-throw negative native cases are not covered by this fixed run/,
  );
  assert.doesNotMatch(source, /_di_expect\([^\n]*'blocked'/);
  assert.doesNotMatch(
    source,
    /fusion_mcp_execute|documents\.add|\.saveAs\(|\.save\(/,
  );
  const manifest = readManifest(path.join(assets, "data-import-program.json"));
  assert.equal(manifest["fixtureId"], "data-import-program-v1");
  assert.equal(manifest["callerCleanupRequired"], true);
});

test("fixed data-import plans match the existing JavaScript normalizer", () => {
  const dataImport = runtimeRequire(
    path.join(projectRoot, "src/data-import.js"),
  ) as DataImportModule;
  const directory = fs.mkdtempSync("/tmp/opencode/data-import-plan-parity-");
  try {
    const owner = "NQGM07IMPORT01_owner";
    const prefix = "NQGM07IMPORT01";
    const source = "Owned synthetic Fusion fixed-run data-import fixture";
    const rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const pose = (frame: string, x = 0): JsonRecord => ({
      frame,
      translation: [`${x} mm`, "0 mm", "0 mm"],
      rotation,
    });
    const records: JsonRecord[] = [
      {
        id: "synthetic-assembly",
        name: `FMCAD_DI_${prefix}_Assembly`,
        kind: "assembly",
        quantity: 1,
        parent: null,
        placement: pose("parent", 10),
        status: "CONFIRMED",
        source,
      },
      {
        id: "synthetic-part",
        name: `FMCAD_DI_${prefix}_Part`,
        kind: "part",
        quantity: 1,
        parent: "synthetic-assembly",
        placement: pose("parent"),
        status: "CONFIRMED",
        source,
      },
      {
        id: "synthetic-cots",
        name: `FMCAD_DI_${prefix}_Sensor`,
        kind: "purchased",
        quantity: 1,
        parent: null,
        placement: pose("parent"),
        mass: { value: 3, unit: "g", status: "ESTIMATED", source },
        status: "CONFIRMED",
        source,
      },
    ];
    const occurrence: JsonRecord = {
      kind: "occurrence",
      path: "root:1",
      token: "offline-occurrence",
    };
    const parameters = dataImport.prepare("param.import", {
      version: 1,
      owner,
      revision: "parameters-r1",
      records: [
        {
          name: `di_${prefix}_width`,
          expression: "5",
          unit: "mm",
          comment: "Synthetic live import",
          status: "CONFIRMED",
          source,
        },
        {
          name: `di_${prefix}_double`,
          expression: `di_${prefix}_width * 2`,
          unit: "mm",
          status: "CONFIRMED",
          source,
        },
      ],
    });
    const catalog = dataImport.prepare("catalog.import", {
      version: 1,
      owner,
      revision: "catalog-r1",
      records,
    });
    const placementRecords: JsonRecord[] = [
      {
        id: "synthetic-assembly",
        occurrence,
        placement: pose("root", 25),
        status: "CONFIRMED",
        source,
      },
    ];
    const placement = dataImport.prepare("placement.import", {
      version: 1,
      owner,
      revision: "placement-r1",
      records: placementRecords,
    });
    const stepPath = path.join(directory, "synthetic-replacement.step");
    fs.writeFileSync(stepPath, "offline fixed-plan hash fixture\n", {
      flag: "wx",
      mode: 0o600,
    });
    const impacts = Object.fromEntries(
      ["matingParts", "routings", "refs", "mass"].map((key) => [
        key,
        {
          status: "known",
          items: [],
          source: "Isolated synthetic fixture inventory",
        },
      ]),
    );
    const cots = dataImport.prepare("cots.replace", {
      version: 1,
      owner,
      revision: "cots-r2",
      expectedRevision: "catalog-r1",
      target: "synthetic-cots",
      model: {
        path: stepPath,
        representation: "envelope",
        source,
        status: "ESTIMATED",
      },
      occurrencePolicy: "all",
      datumMap: [
        { name: "mount", old: pose("component"), new: pose("component") },
      ],
      impacts,
      mass: { value: 3, unit: "g", status: "ESTIMATED", source },
      acceptInvalidation: true,
    });
    cots.result["model"] = {
      ...asRecord(cots.result["model"], "COTS plan model"),
      fusionPath: stepPath,
    };

    const program = path.join(assets, "data-import.py");
    const inputPath = path.join(directory, "plans.json");
    fs.writeFileSync(
      inputPath,
      JSON.stringify({ prefix, owner, stepPath, occurrence }),
      { flag: "wx", mode: 0o600 },
    );
    const code =
      `import json,runpy,sys\nm=runpy.run_path(sys.argv[1]); x=json.load(open(sys.argv[2]))\n` +
      `p=m['_di_param_plan'](x['owner'],'parameters-r1',('di_'+x['prefix']+'_width','di_'+x['prefix']+'_double'))\n` +
      `r=m['_di_catalog_records'](x['prefix']); c=m['_di_catalog_plan'](x['owner'],'catalog-r1',r)\n` +
      `q=m['_di_placement_plan'](x['owner'],'placement-r1',m['_di_placement_records'](x['occurrence']))\n` +
      `t=m['_di_cots_plan'](x['owner'],'cots-r2','catalog-r1',x['stepPath'],m['_di_file_hash'](x['stepPath']))\n` +
      `print(json.dumps({'parameters':p,'catalog':c,'placement':q,'cots':t},allow_nan=False))`;
    const result = spawnSync(
      "python3",
      ["-B", "-c", code, program, inputPath],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const nativePlans = asRecord(
      JSON.parse(result.stdout) as unknown,
      "Fixed data-import Python plans",
    );
    for (const [name, expected] of Object.entries({
      parameters,
      catalog,
      placement,
      cots,
    })) {
      const actual = asRecord(nativePlans[name], `Python ${name} plan`);
      assert.deepEqual(
        actual["result"],
        expected.result,
        `${name} normalized result`,
      );
      assert.equal(
        actual["digest"],
        expected.digest,
        `${name} normalized digest`,
      );
      assert.deepEqual(
        actual["unresolved"],
        expected.unresolved,
        `${name} unresolved evidence`,
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("fixed section source imports without SDK access and retains required native fixture cases", () => {
  const file = path.join(assets, "sections.py");
  assertPythonImports(file);
  const source = fs.readFileSync(file, "utf8");
  for (const name of [
    "material-pass",
    "void-pass",
    "void-fail",
    "missing-sector-fail",
    "gap-between-stations-fail",
    "closed-ring-sections",
    "closed-c-section-missing-sector",
    "native-open-wire-kernel-error",
    "gap-stations-miss-defect",
    "empty-intersection",
    "tangent-degenerate-kernel-result",
    "frame-mismatch",
  ])
    assert.ok(source.includes(name), name);
  assert.ok(source.includes("createWireFromCurves(curves)"));
  assert.ok(source.includes("createFaceFromPlanarWires([wire])"));
  assert.doesNotMatch(source, /2706\.1\.14/);
});

test("fixed sketch proof imports without SDK effects and covers every retained required case", () => {
  const file = path.join(assets, "sketch-proof.py");
  assertPythonImports(file);
  const source = fs.readFileSync(file, "utf8");
  const deferred = runtimeRequire(
    path.join(
      projectRoot,
      "tests/native/integrated-qualification/deferred_adapters.js",
    ),
  ) as SketchCasesModule;
  for (const name of deferred.SKETCH_CASES)
    assert.ok(source.includes(name), name);
  assert.ok(source.includes("'sketch.coordinate-check'"));
  assert.ok(source.includes("value.get('precision') == 'sampled'"));
});

test("fixed measured fasteners imports without SDK effects and separates declarations from native cases", () => {
  const file = path.join(assets, "measured-fasteners.py");
  assertPythonImports(file);
  const source = fs.readFileSync(file, "utf8");
  for (const name of [
    "declared-stack-is-separate",
    "baseline-native-engagement",
    "measurement-source-frame-and-coverage",
    "bottoming-negative-even-with-legacy-pass",
    "short-bolt-minimum-engagement-negative",
    "misaligned-native-axes-negative",
    "missing-native-measurement-remains-unknown",
    "model-and-save-state-unchanged",
  ])
    assert.ok(source.includes(name), name);
  assert.ok(
    source.indexOf("body_count =") <
      source.indexOf("baseline = _fastener_call('fastener.measured-check'"),
  );
  assert.ok(source.includes("'space': 'assembly'"));
});
