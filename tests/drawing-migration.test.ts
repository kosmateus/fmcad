import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { DrawingApi, DrawingFixture } from "./drawing-test-support";
const load = createRequire(
  path.join(process.cwd(), "tests/drawing-migration.test.ts"),
);
const history = load("./fixtures/file-workflows/load.cjs") as (
  label: string,
  file: string,
  overrides?: Record<string, unknown>,
) => DrawingApi;
const drawing = load("../src/drawing-package") as DrawingApi;
const current = load("../src/drawing-export") as DrawingApi;
const check = load("../src/drawing-check") as DrawingApi;
const { publishDirectory } = load(
  "../src/dist/node-adapters/persistence/drawing-output",
) as typeof import("../packages/node-adapters/src/persistence/drawing-output");
const versions = ["baseline", "before", "typed"];
function fixture(t: import("node:test").TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawing-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const request = structuredClone(
    drawing.descriptors["drawing.package"]!.example,
  );
  request.out = path.join(root, "package");
  const report = drawing.execute("drawing.package", request);
  return { root, report, out: path.join(root, "output") };
}
function api(label: string, family: string, io?: typeof fs): DrawingApi {
  if (label !== "typed")
    return history(label, `src/drawing-${family}.js`, { "node:fs": io ?? fs });
  if (!io) return family === "export" ? current : check;
  // Factories expose filesystem ports for deterministic fault injection.
  const module = load(
    `../src/dist/node-adapters/persistence/drawing-${family}`,
  ) as {
    createDrawingExporter(ports: DrawingApi, io: typeof fs): DrawingApi;
    createDrawingChecker(ports: DrawingApi, io: typeof fs): DrawingApi;
  };
  return family === "export"
    ? module.createDrawingExporter(drawing, io)
    : module.createDrawingChecker(drawing, io);
}
test("drawing migration preserves complete export bytes, check reports and source identities", (t) => {
  const { report, out } = fixture(t);
  const exports = [],
    checks = [];
  for (const label of versions) {
    const result = api(label, "export").execute("drawing.export", {
      schemaVersion: 1,
      package: report.reportPath,
      out,
      formats: ["svg", "pdf", "dxf"],
    });
    exports.push({
      result,
      files: Object.fromEntries(
        fs
          .readdirSync(out)
          .map((name) => [name, fs.readFileSync(path.join(out, name), "hex")]),
      ),
    });
    fs.rmSync(out, { recursive: true });
    const checked = api(label, "check").execute("drawing.check", {
      schemaVersion: 1,
      package: report.reportPath,
      out,
    });
    checks.push({
      checked,
      bytes: fs.readFileSync(path.join(out, "report.json"), "hex"),
    });
    fs.rmSync(out, { recursive: true });
  }
  for (const snapshot of exports.slice(1))
    assert.deepEqual(snapshot, exports[0]);
  for (const snapshot of checks.slice(1)) assert.deepEqual(snapshot, checks[0]);
});
for (const label of versions) {
  for (const family of ["check", "export"]) {
    test(`${label} ${family}: failed publication removes owned partial output without changing the package`, (t) => {
      const { report, out } = fixture(t),
        original = fs.readFileSync(report.reportPath);
      const failure = new Error("injected report publication failure");
      const io: typeof fs = {
        ...fs,
        writeFileSync(file, ...args) {
          if (path.basename(file as string) === "report.json") throw failure;
          return fs.writeFileSync(file, ...args);
        },
      };
      assert.throws(
        () =>
          api(label, family, io).execute("drawing." + family, {
            schemaVersion: 1,
            package: report.reportPath,
            out,
            formats: ["svg", "pdf"],
          }),
        (error) => error === failure,
      );
      assert.equal(fs.existsSync(out), false);
      assert.deepEqual(fs.readFileSync(report.reportPath), original);
    });
    test(`${label} ${family}: cleanup failure retains both errors in the migrated implementation`, (t) => {
      const { report, out } = fixture(t);
      const publication = new Error("original failure"),
        cleanup = new Error("cleanup failure");
      const io: typeof fs = {
        ...fs,
        writeFileSync() {
          throw publication;
        },
        rmSync() {
          throw cleanup;
        },
      };
      assert.throws(
        () =>
          api(label, family, io).execute("drawing." + family, {
            schemaVersion: 1,
            package: report.reportPath,
            out,
            formats: ["svg"],
          }),
        (error) => {
          if (label !== "typed") return error === cleanup; // Reproduces the inherited loss of the original error.
          assert.ok(error instanceof AggregateError);
          assert.equal((error as AggregateError).cause, publication);
          assert.deepEqual((error as AggregateError).errors, [
            publication,
            cleanup,
          ]);
          return true;
        },
      );
    });
    test(`${label} ${family}: changed scene is refused before creating output`, (t) => {
      const { report, out } = fixture(t);
      fs.appendFileSync(report.result.scene.path, "changed");
      assert.throws(
        () =>
          api(label, family).execute("drawing." + family, {
            schemaVersion: 1,
            package: report.reportPath,
            out,
            formats: ["svg"],
          }),
        /sha256 mismatch/,
      );
      assert.equal(fs.existsSync(out), false);
    });
  }
}
test("cleanup refuses a replacement directory and preserves its foreign contents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drawing-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, "out"),
    retained = path.join(root, "original");
  const original = new Error("publication interrupted");
  assert.throws(
    () =>
      publishDirectory(out, fs, () => {
        fs.renameSync(out, retained);
        fs.mkdirSync(out);
        fs.writeFileSync(path.join(out, "foreign"), "protected");
        throw original;
      }),
    (error) => {
      assert.equal((error as AggregateError).cause, original);
      assert.match(
        ((error as AggregateError).errors[1] as Error).message,
        /ownership changed/,
      );
      return true;
    },
  );
  assert.equal(fs.readFileSync(path.join(out, "foreign"), "utf8"), "protected");
  assert.ok(fs.existsSync(retained));
});

const packageVersions = ["baseline", "package-before", "typed"];
function packageApi(label: string, io: typeof fs = fs): DrawingApi {
  return label === "typed"
    ? (
        load("../src/dist/node-adapters/persistence/drawing-package") as {
          createDrawingPackage(
            descriptors: DrawingApi["descriptors"],
            io: typeof fs,
          ): DrawingApi;
        }
      ).createDrawingPackage(drawing.descriptors, io)
    : history(label, "src/drawing-package.js", { "node:fs": io });
}
function packageRequest(t: import("node:test").TestContext) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "drawing-package-paired-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    request: {
      ...structuredClone(drawing.descriptors["drawing.package"]!.example),
      out: path.join(root, "output"),
    },
  };
}
function packageObservation(fn: () => unknown): {
  value?: unknown;
  message?: string;
  code?: string | undefined;
} {
  try {
    return { value: fn() };
  } catch (error) {
    return {
      message: (error as Error).message,
      code: (error as NodeJS.ErrnoException).code,
    };
  }
}
test("typed drawing package preserves complete model, scene bytes, report hashes and native gate", (t) => {
  const { request } = packageRequest(t);
  const variants = [request, { ...request, representation: "native" }];
  const expanded = structuredClone(request);
  expanded.views.push({
    id: "sec",
    kind: "section",
    parent: "front",
    cutFrom: [30, 0],
    cutTo: [30, 40],
    scale: 2,
    origin: [220, 40],
    geometry: [
      {
        kind: "polyline",
        points: [
          [0, 0],
          [40, 0],
          [40, 20],
          [0, 20],
        ],
        closed: true,
      },
      {
        kind: "hatch",
        boundary: [
          [0, 0],
          [40, 0],
          [40, 20],
          [0, 20],
        ],
        spacing: 3,
      },
    ],
  });
  expanded.views.push({
    id: "det",
    kind: "detail",
    parent: "front",
    detailFrom: [30, 20],
    detailRadius: 8,
    scale: 4,
    origin: [220, 160],
    geometry: [
      { kind: "circle", id: "bore-detail", center: [0, 0], r: 5 },
      { kind: "arc", center: [0, 0], r: 8, startDeg: 20, sweepDeg: 120 },
    ],
  });
  expanded.datums = [
    {
      id: "A",
      view: "front",
      kind: "plane",
      at: [0, 0],
      source: { path: "datum.json", status: "CONFIRMED" },
    },
  ];
  expanded.controls = [
    {
      id: "c1",
      view: "front",
      kind: "position",
      target: "bore",
      value: "0.1 mm",
      datums: ["A"],
      source: { path: "control.json", status: "CONFIRMED" },
    },
  ];
  expanded.dimensions.push({
    id: "angle",
    view: "front",
    kind: "angle",
    vertex: [0, 0],
    a: [10, 0],
    b: [0, 10],
    value: "90 deg",
    source: { path: "angles", status: "CONFIRMED" },
  });
  variants.push(expanded);
  for (const status of ["ESTIMATED", "OPEN"]) {
    const value = structuredClone(request);
    value.dimensions[0]!.source.status = status;
    delete value.dimensions[0]!.tolerance;
    variants.push(value);
  }
  for (const value of variants) {
    const results = packageVersions.map((label) => {
      const api = packageApi(label),
        result = api.execute("drawing.package", structuredClone(value));
      const files = fs.existsSync(value.out)
        ? Object.fromEntries(
            fs
              .readdirSync(value.out)
              .map((name) => [
                name,
                fs.readFileSync(path.join(value.out, name), "hex"),
              ]),
          )
        : {};
      const readback = result.reportPath
        ? api.readPackage(result.reportPath, "drawing.package")
        : null;
      fs.rmSync(value.out, { recursive: true, force: true });
      assert.equal(result.nativeAcceptance, "notEvaluated");
      return { result, files, readback };
    });
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
  }
});
test("typed drawing package retains exact validation failures without publishing artifacts", (t) => {
  const { request } = packageRequest(t);
  const mutations: ((r: DrawingFixture) => void)[] = [
    (r) => {
      r.sheet.format = "unknown";
    },
    (r) => {
      r.views[0]!.scale = 0;
    },
    (r) => {
      r.views[0]!.geometry[0]!.kind = "unknown";
    },
    (r) => {
      r.dimensions[0]!.source.status = "ESTIMATED";
    },
    (r) => {
      r.dimensions[0]!.a = { entity: "foreign" };
    },
    (r) => {
      r.balloons[0]!.item = 999;
    },
    (r) => {
      r.items.push(r.items[0]!);
    },
    (r) => {
      r.views.push(r.views[0]!);
    },
    (r) => {
      r.controls = [
        {
          id: "bad",
          view: "front",
          kind: "runout",
          target: "bore",
          value: "1 mm",
        },
      ];
    },
    (r) => {
      r.schemaVersion = 2;
    },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(request);
    mutate(value);
    const results = packageVersions.map((label) =>
      packageObservation(() =>
        packageApi(label).execute("drawing.package", structuredClone(value)),
      ),
    );
    assert.ok(results[0]!.message);
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
    assert.equal(fs.existsSync(value.out), false);
  }
});
for (const label of packageVersions) {
  test(`${label} package publication removes partial files and retains cleanup failure evidence`, (t) => {
    const { request } = packageRequest(t),
      failure = new Error("report write failed"),
      cleanup = new Error("cleanup failed");
    const io: typeof fs = {
      ...fs,
      writeFileSync(file, ...args) {
        if (path.basename(file as string) === "report.json") throw failure;
        return fs.writeFileSync(file, ...args);
      },
    };
    assert.throws(
      () => packageApi(label, io).execute("drawing.package", request),
      (error) => error === failure,
    );
    assert.equal(fs.existsSync(request.out), false);
    assert.throws(
      () =>
        packageApi(label, {
          ...io,
          rmSync() {
            throw cleanup;
          },
        }).execute("drawing.package", request),
      (error) => {
        if (label !== "typed") return error === cleanup;
        assert.equal((error as AggregateError).cause, failure);
        assert.deepEqual((error as AggregateError).errors, [failure, cleanup]);
        return true;
      },
    );
    assert.ok(fs.existsSync(path.join(request.out, "scene.json")));
  });
  test(`${label} package never erases foreign directory contents after ownership changes`, (t) => {
    const { root, request } = packageRequest(t),
      retained = path.join(root, "retained"),
      failure = new Error("report interrupted");
    const io: typeof fs = {
      ...fs,
      writeFileSync(file, ...args) {
        if (path.basename(file as string) === "report.json") {
          fs.renameSync(request.out, retained);
          fs.mkdirSync(request.out);
          fs.writeFileSync(path.join(request.out, "foreign"), "protected");
          throw failure;
        }
        return fs.writeFileSync(file, ...args);
      },
    };
    assert.throws(
      () => packageApi(label, io).execute("drawing.package", request),
      (error) => {
        if (label !== "typed") return error === failure;
        assert.equal((error as AggregateError).cause, failure);
        assert.match(
          ((error as AggregateError).errors[1] as Error).message,
          /ownership changed/,
        );
        return true;
      },
    );
    // Both historical implementations delete the substituted directory: inherited defect.
    assert.equal(
      fs.existsSync(path.join(request.out, "foreign")),
      label === "typed",
    );
    assert.ok(fs.existsSync(path.join(retained, "scene.json")));
  });
  test(`${label} package serialization failure does not silently leave an owned partial publication`, (t) => {
    const { request } = packageRequest(t),
      cycle: unknown[] = [];
    cycle.push(cycle);
    request.controls = [
      {
        id: "control",
        view: "front",
        kind: "flatness",
        target: "bore",
        value: "1 mm",
        source: { path: "derived", status: "DERIVED", derivedFrom: cycle },
      },
    ];
    assert.throws(
      () => packageApi(label).execute("drawing.package", request),
      /circular/i,
    );
    // Historically report serialization was outside the cleanup boundary.
    assert.equal(
      fs.existsSync(path.join(request.out, "scene.json")),
      label !== "typed",
    );
  });
}
test("package ownership lookup failure stops before writes and retains uncertain evidence", (t) => {
  for (const label of packageVersions) {
    const { request } = packageRequest(t),
      failure = new Error("inode lookup failed");
    let writes = 0;
    const io: typeof fs = {
      ...fs,
      lstatSync() {
        throw failure;
      },
      writeFileSync(...args) {
        writes++;
        return fs.writeFileSync(...args);
      },
    };
    if (label === "typed") {
      assert.throws(
        () => packageApi(label, io).execute("drawing.package", request),
        (error) => error === failure,
      );
      assert.equal(writes, 0);
      assert.deepEqual(fs.readdirSync(request.out), []);
    } else {
      // Historical publication never established directory ownership.
      assert.equal(
        packageApi(label, io).execute("drawing.package", request).status,
        "pass",
      );
      assert.equal(writes, 2);
    }
  }
});

test("drawing package readback preserves missing, malformed and foreign report failures and original evidence", (t) => {
  const { root, request } = packageRequest(t),
    report = drawing.execute("drawing.package", request),
    file = report.reportPath;
  const original = fs.readFileSync(file);
  for (const contents of [
    "{broken",
    JSON.stringify({ ...report, operation: "foreign" }),
    JSON.stringify({ ...report, schemaVersion: 999 }),
  ]) {
    fs.writeFileSync(file, contents);
    const results = packageVersions.map((label) =>
      packageObservation(() =>
        packageApi(label).readPackage(file, "drawing.package"),
      ),
    );
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
    assert.equal(fs.readFileSync(file, "utf8"), contents);
  }
  fs.writeFileSync(file, original);
  for (const label of packageVersions)
    assert.throws(
      () =>
        packageApi(label).readPackage(
          path.join(root, "missing.json"),
          "drawing.package",
        ),
      { code: "ENOENT" },
    );
  assert.deepEqual(fs.readFileSync(file), original);
});

test("typed drawing composition preserves every local descriptor and manual return contract", () => {
  type Composition =
    typeof import("../src/composition/library-drawing-package");
  const current = load("../src/drawing-package") as Composition;
  for (const label of ["baseline", "package-before"]) {
    const historical = history(
      label,
      "src/drawing-package.js",
    ) as unknown as Composition;
    assert.deepEqual(current.descriptors, historical.descriptors);
    assert.deepEqual(current.familyDescriptors, historical.familyDescriptors);
    for (const operation of Object.keys(current.manuals)) {
      assert.deepEqual(
        current.manuals[operation]!.sections,
        historical.manuals[operation]!.sections,
      );
      assert.deepEqual(
        current.manuals[operation]!.examples,
        historical.manuals[operation]!.examples,
      );
    }
  }
});
