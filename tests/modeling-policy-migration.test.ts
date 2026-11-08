import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const root = process.cwd();
const load = createRequire(path.join(root, "package.json"));
interface Policy {
  prepare?: (operation: string, data: Record<string, unknown>) => unknown;
  validate(operation: string, data: unknown): void;
  descriptors?: Record<string, unknown>;
}
interface Fixture {
  family: string;
  revision: string;
  file: string;
  sha256: string;
}
const folder = path.join(root, "tests/fixtures/modeling-history");
const manifest: Fixture[] = JSON.parse(
  fs.readFileSync(path.join(folder, "manifest.json"), "utf8"),
);
const catalog = (
  load("./src/cad") as { catalog: Record<string, { example?: unknown }> }
).catalog;
function historical(entry: Fixture): Policy {
  const bytes = fs.readFileSync(path.join(folder, entry.file));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  const context = {
    module: { exports: {} },
    require: createRequire(path.join(root, "src", entry.family + ".js")),
    process,
  };
  vm.runInNewContext(bytes.toString("utf8"), context, { filename: entry.file });
  return context.module.exports as Policy;
}
function outcome(policy: Policy, operation: string, value: unknown): string {
  const data: unknown = structuredClone(value);
  const before = JSON.stringify(data);
  try {
    policy.validate(operation, data);
    return "accepted";
  } catch (error) {
    return error instanceof Error
      ? error.message
      : String((error as { message: string }).message);
  } finally {
    assert.equal(
      JSON.stringify(data),
      before,
      "validation must not mutate input",
    );
  }
}
const origin = ["0 mm", "0 mm", "0 mm"];
const cases: Record<string, [string, unknown][]> = {
  sketch: [
    [
      "sketch.build",
      {
        geometry: [
          {
            type: "rectangle",
            name: "box",
            start: origin,
            end: ["10 mm", "20 mm", "0 mm"],
          },
        ],
      },
    ],
    [
      "sketch.geometry",
      {
        sketch: "S",
        geometry: [
          { type: "line", start: origin, end: ["-1 mm", "0 mm", "1 mm"] },
        ],
      },
    ],
    [
      "sketch.geometry",
      {
        sketch: "S",
        geometry: [{ type: "line", start: [0, 0, 0], end: origin }],
      },
    ],
    [
      "sketch.geometry",
      {
        sketch: "S",
        geometry: [
          {
            type: "bezier",
            controlPoints: [origin, origin, origin, origin],
            fixed: false,
          },
        ],
      },
    ],
    [
      "sketch.dimension",
      {
        sketch: "S",
        type: "radius",
        entities: ["circle"],
        text: origin,
        expression: "5 mm",
      },
    ],
    [
      "sketch.dimension",
      {
        sketch: "S",
        type: "radius",
        entities: ["circle"],
        text: origin,
        driving: false,
      },
    ],
    [
      "sketch.dimension",
      {
        sketch: "S",
        type: "radius",
        entities: ["circle"],
        text: origin,
        driving: false,
        expression: "5 mm",
      },
    ],
    [
      "sketch.transform",
      {
        sketch: "S",
        entities: ["line"],
        rotate: { angle: "30 deg", center: origin },
      },
    ],
    [
      "sketch.transform",
      {
        sketch: "S",
        entities: ["line"],
        rotate: { angle: "30 deg", scale: 2 },
      },
    ],
    ["sketch.dimension-plan", { sketch: "S", maxEntities: 0 }],
    [
      "sketch.dimension-apply",
      { sketch: "S", plan: { $ref: "plan" }, accept: ["a", "a"] },
    ],
    ["sketch.edit", { sketch: "S", movePoints: [] }],
  ],
  spring: [
    [
      "curve.helix",
      { schemaVersion: 1, frame: "component", radius: "4 mm", pitch: "5 mm" },
    ],
    [
      "curve.helix",
      { schemaVersion: 1, frame: "component", pitch: "5 mm", height: "30 mm" },
    ],
    [
      "spring.evaluate",
      { schemaVersion: 1, frame: "component", activeCoils: -1 },
    ],
    [
      "spring.configure",
      {
        schemaVersion: 1,
        frame: "component",
        compressedLength: "5 mm",
        deflection: "2 mm",
      },
    ],
  ],
  thread: [
    [
      "thread.custom-profile",
      {
        schemaVersion: 1,
        frame: "component",
        majorDiameter: "10 mm",
        pitch: "1.5 mm",
      },
    ],
    [
      "thread.custom-profile",
      {
        schemaVersion: 1,
        frame: "component",
        majorDiameter: "10 mm",
        pitch: "1.5 mm",
        minorDiameter: "8 mm",
        pitchDiameter: "9 mm",
      },
    ],
    [
      "thread.pair-check",
      { schemaVersion: 1, frame: "component", external: [], internal: {} },
    ],
    [
      "thread.catalog",
      { schemaVersion: 1, frame: "component", system: "unsupported" },
    ],
  ],
  "entity-query": [
    [
      "entity.find",
      {
        kind: "edge",
        filters: { radius: { min: "1 mm" } },
        expect: { min: 0, max: 2 },
      },
    ],
    ["entity.find", { expect: { min: 3, max: 1 } }],
    ["entity.stats", { filters: { axis: [0, 0, 0] } }],
    ["entity.find", { scope: { body: "B", feature: "F" } }],
    ["entity.find", { frame: { sketch: "S", occurrence: "P:1" } }],
    ["entity.find", { unique: true, expect: 1 }],
    ["model.fillet", { query: { kind: "edge", expect: 1 }, radius: "1 mm" }],
    ["model.fillet", { query: { kind: "face", expect: 1 }, radius: "1 mm" }],
    ["model.fillet", { query: {}, radius: "1 mm" }],
    ["measure.length", { ref: { query: { kind: "edge", expect: 1 } } }],
    [
      "check",
      {
        measurement: {
          operation: "measure.length",
          data: { ref: { query: { expect: true } } },
        },
      },
    ],
  ],
  fastener: [
    [
      "fastener.check",
      {
        schemaVersion: 1,
        frame: "component",
        screw: { length: "12 mm", threadLength: "10 mm" },
        stack: [{ thickness: "4 mm" }],
      },
    ],
    [
      "fastener.check",
      {
        schemaVersion: 1,
        frame: "component",
        screw: { length: 12, threadLength: "10 mm" },
        stack: [{ thickness: "4 mm" }],
      },
    ],
    [
      "mount.create",
      { schemaVersion: 1, frame: "component", scheme: "unsupported" },
    ],
    ["snap.evaluate", { schemaVersion: 1, frame: "component", material: {} }],
  ],
  "feature-rework": [
    ["feature.edit", { feature: "F", parameters: { distance: "10 mm" } }],
    [
      "feature.edit",
      {
        schemaVersion: 1,
        frame: "component",
        feature: "F",
        entries: [{ role: "distance", expression: "10 mm" }],
      },
    ],
    [
      "feature.edit",
      {
        schemaVersion: 1,
        frame: "component",
        feature: "F",
        extent: { mode: "twoSides", distance: "10 mm" },
      },
    ],
    [
      "feature.edit",
      {
        schemaVersion: 1,
        frame: "component",
        feature: "F",
        extent: { mode: "toEntity", target: "Face", distance: "10 mm" },
      },
    ],
    [
      "feature.edit",
      {
        schemaVersion: 1,
        frame: "component",
        feature: "F",
        operationChange: {
          expected: "newBody",
          value: "join",
          expectedResultBodyCount: 1,
        },
      },
    ],
  ],
  datum: [
    [
      "datum.transform",
      {
        from: "component",
        to: "root",
        points: [["1 mm", "2 mm", "3 mm"]],
        vectors: [[0, 0, 0]],
      },
    ],
    [
      "datum.transform",
      {
        from: "component",
        to: "root",
        differences: [
          { from: ["0 mm", "0 mm", "0 mm"], to: ["1 mm", "2 mm", "3 mm"] },
        ],
      },
    ],
    [
      "datum.plane-on-path",
      {
        path: { curves: ["curve"] },
        position: { mode: "proportional", value: "1.1" },
      },
    ],
    ["datum.point", { frame: "root", associativity: "live" }],
    [
      "occurrence.transform",
      {
        placement: {
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          translationUnits: "mm",
        },
      },
    ],
    [
      "occurrence.transform",
      {
        placement: {
          matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          translationUnits: "mm",
        },
      },
    ],
    ["joint.revolute", { frame: "root", associativity: "snapshot" }],
    ["joint.revolute", { frame: "root", axis: "Z", associativity: "snapshot" }],
  ],
  surface: [
    [
      "surface.trim",
      {
        schemaVersion: 1,
        frame: "component",
        mode: "apply",
        plan: {},
        removeCells: [0, 0],
      },
    ],
    [
      "surface.trim",
      { schemaVersion: 1, frame: "component", mode: "plan", removeCells: [0] },
    ],
    [
      "surface.extend",
      {
        schemaVersion: 1,
        frame: "component",
        distance: "2 mm",
        protected: ["B"],
        tangentChain: true,
      },
    ],
    [
      "surface.check",
      {
        schemaVersion: 1,
        frame: "component",
        seams: [{ edgeA: "a", faceA: "A", edgeB: "b", faceB: "B" }],
      },
    ],
    [
      "model.loft",
      {
        solid: false,
        endConditions: { start: { type: "direction", angle: "10 deg" } },
      },
    ],
    ["model.loft", { solid: false, endConditions: "bad" }],
    [
      "model.loft",
      { solid: false, endConditions: { start: { type: "free", weight: "1" } } },
    ],
    ["model.loft", { solid: true, schemaVersion: 1 }],
  ],
  seal: [],
  cam: [],
};
for (const entry of manifest) {
  const old = historical(entry);
  const current = load("./src/" + entry.family) as Policy;
  test(`${entry.family}: descriptors remain identical at ${entry.revision.slice(0, 7)}`, () => {
    assert.equal(
      JSON.stringify(
        entry.family === "fastener" && entry.revision.startsWith("a26222f")
          ? Object.fromEntries(
              Object.entries(current.descriptors ?? {}).filter(
                ([key]) => key !== "fastener.measured-check",
              ),
            )
          : current.descriptors,
      ),
      JSON.stringify(old.descriptors),
    );
  });
  const examples = Object.keys(old.descriptors ?? {}).map(
    (op) => [op, catalog[op]?.example] as [string, unknown],
  );
  for (const [index, [operation, data]] of [
    ...examples,
    ...(cases[entry.family] ?? []),
  ].entries()) {
    test(`${entry.family}: paired case ${index} ${operation} at ${entry.revision.slice(0, 7)}`, () => {
      assert.equal(
        outcome(current, operation, data),
        outcome(old, operation, data),
      );
    });
  }
}
const sketch = load("./src/sketch") as Policy;
const currentSketch = historical(
  manifest.find(
    (e) => e.family === "sketch" && e.revision.startsWith("0b84454"),
  )!,
);
for (const op of ["sketch.coordinate-check", "sketch.profile-query"]) {
  test(`${op}: post-baseline proof routes retain their own historical contract`, () => {
    for (const data of [
      catalog[op]?.example,
      { schemaVersion: 1, sketch: "S", expected: { profiles: -1 } },
      { schemaVersion: 1, sketch: "S", query: { area: 0 } },
    ]) {
      assert.equal(outcome(sketch, op, data), outcome(currentSketch, op, data));
    }
  });
}
test("public sketch entrypoint is the canonical compiled policy", () => {
  assert.equal(sketch, load("./src/dist/core/application/modeling/sketch"));
});

for (const fixture of manifest.filter((entry) => entry.family === "curve")) {
  test(`curve: complete source plans and failures at ${fixture.revision.slice(0, 7)}`, (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "curve-history-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const old = historical(fixture),
      current = load("./src/curve") as Policy;
    assert.ok(old.prepare);
    assert.ok(current.prepare);
    const base = {
      schemaVersion: 1,
      sketch: "Profile",
      frame: "sketch",
      plane: "sketchXY",
      units: { length: "mm" },
      columns: { x: "x", y: "y" },
      closed: false,
      records: [
        { x: 0, y: 0 },
        { x: 10, y: 5 },
      ],
    };
    const { records, ...fileBase } = base;
    fs.writeFileSync(
      path.join(directory, "points.json"),
      JSON.stringify({ data: records }),
    );
    fs.writeFileSync(
      path.join(directory, "points.csv"),
      "theta;r;state\n0;10;ESTIMATED\n90;10;CONFIRMED\n",
    );
    const inputs: Record<string, unknown>[] = [
      base,
      {
        ...base,
        columns: { x: 0, y: 1 },
        records: [
          [0, 0],
          [10, 5],
        ],
      },
      { ...base, columns: { x: 0, y: 1 }, records: ["12", "34"] },
      {
        ...base,
        closed: true,
        winding: "cw",
        records: [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
          { x: 0, y: 2 },
          { x: 0.0001, y: 0 },
        ],
      },
      { ...base, interpolation: "spline" },
      {
        ...base,
        records: [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
      },
      { ...base, closed: true },
      { ...base, units: { length: "deg" } },
      {
        ...base,
        records: [
          { x: "", y: 0 },
          { x: 1, y: 2 },
        ],
      },
      { ...base, maxSamples: 1 },
      { ...base, plane: "XY" },
      {
        ...base,
        columns: { x: "x", y: "y", z: "z" },
        records: [
          { x: 0, y: 0, z: 1 },
          { x: 1, y: 2, z: 0 },
        ],
      },
      {
        ...fileBase,
        baseDir: directory,
        source: "points.json",
        recordsPath: "data",
      },
      {
        ...fileBase,
        baseDir: directory,
        source: "points.csv",
        delimiter: ";",
        columns: { angle: "theta", radius: "r", status: "state" },
        units: { length: "mm", angle: "deg" },
      },
    ];
    const observe = (
      prepare: NonNullable<Policy["prepare"]>,
      input: Record<string, unknown>,
    ) => {
      const copy = structuredClone(input),
        before = JSON.stringify(copy);
      try {
        return { output: JSON.stringify(prepare("curve.fit", copy)) };
      } catch (error) {
        return { error: String((error as { message: string }).message) };
      } finally {
        assert.equal(JSON.stringify(copy), before);
      }
    };
    for (const input of inputs)
      assert.deepEqual(
        observe(current.prepare, input),
        observe(old.prepare, input),
      );
  });
}

interface SpecialistFixture {
  path: string;
  revision: string;
  sha256: string;
}
const specialistFolder = path.join(
  root,
  "tests/fixtures/modeling-specialist-history",
);
const specialistHistory: Record<string, SpecialistFixture> = JSON.parse(
  fs.readFileSync(path.join(specialistFolder, "manifest.json"), "utf8"),
);
const specialistOperations: Record<string, string[]> = {
  "native-drive": ["mechanism.drive-test", "mechanism.motion-link.create"],
  "regional-geometry": ["geometry.delta", "geometry.compare-region"],
  "section-witness": ["measure.section-series", "measure.witness-check"],
  "semantic-model-state": [
    "frame.context_audit",
    "snapshot.capture_v2",
    "snapshot.diff_v2",
  ],
  "selection-rules": [
    "selection.rule.define",
    "selection.rule.inspect",
    "selection.rule.resolve",
    "selection.rule.check",
  ],
  "brep-baseline": [
    "measure.baseline.capture",
    "measure.baseline.inspect",
    "measure.baseline.compare",
  ],
};
function specialistOutcome(
  policy: Policy,
  operation: string,
  value: unknown,
): unknown {
  const data: unknown = structuredClone(value),
    before = structuredClone(data);
  try {
    return { value: policy.validate(operation, data) };
  } catch (error) {
    assert.ok(
      error &&
        typeof error === "object" &&
        "message" in error &&
        "name" in error,
    );
    return { name: error.name, message: error.message };
  } finally {
    assert.deepEqual(data, before, "specialist validation mutated its input");
  }
}
function* specialistInputs(
  example: unknown,
): Generator<{ label: string; data: unknown }> {
  yield { label: "valid public example", data: example };
  const replacements: unknown[] = [
    null,
    false,
    0,
    -1,
    "",
    "foreign",
    [],
    {},
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ];
  for (const replacement of replacements)
    yield { label: "root=" + String(replacement), data: replacement };
  function* walk(value: unknown, parts: string[]): Generator<string[]> {
    if (!value || typeof value !== "object" || parts.length >= 8) return;
    for (const [key, child] of Object.entries(value)) {
      const next = [...parts, key];
      yield next;
      yield* walk(child, next);
    }
  }
  for (const parts of walk(example, [])) {
    for (const replacement of [undefined, ...replacements]) {
      const data: unknown = structuredClone(example);
      let parent: unknown = data;
      for (const part of parts.slice(0, -1)) {
        assert.ok(parent && typeof parent === "object");
        parent = Reflect.get(parent, part);
      }
      assert.ok(parent && typeof parent === "object");
      const key = parts.at(-1);
      assert.ok(key);
      if (replacement === undefined) Reflect.deleteProperty(parent, key);
      else Reflect.set(parent, key, replacement);
      yield { label: parts.join(".") + "=" + String(replacement), data };
    }
  }
}
for (const [family, entry] of Object.entries(specialistHistory)) {
  test(`specialist ${family}: every public example and nested negative preserves historical errors and no mutation`, (t) => {
    let comparisons = 0;
    const source = fs.readFileSync(
      path.join(specialistFolder, family + ".js.txt"),
    );
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      entry.sha256,
    );
    const context = { module: { exports: {} } };
    vm.runInNewContext(source.toString("utf8"), context, {
      filename: entry.path,
    });
    const previous = context.module.exports as Policy;
    const current = load("./" + entry.path) as Policy;
    for (const operation of specialistOperations[family] ?? []) {
      const example = catalog[operation]?.example;
      assert.ok(example, operation);
      assert.deepEqual(specialistOutcome(previous, operation, example), {
        value: undefined,
      });
      for (const { label, data } of specialistInputs(example)) {
        comparisons++;
        assert.deepEqual(
          specialistOutcome(current, operation, data),
          specialistOutcome(previous, operation, data),
          operation + " " + label,
        );
      }
    }
    assert.deepEqual(
      specialistOutcome(current, "unrelated.operation", null),
      specialistOutcome(previous, "unrelated.operation", null),
    );
    t.diagnostic(`${comparisons} paired input scenarios`);
  });
}

interface PrivateSpecialist {
  isInternal(operation: string): boolean;
  authorize(...args: unknown[]): void;
  validateInternal(operation: string, data: unknown): unknown;
}
const privateSpecialistHistory: Record<string, SpecialistFixture> = JSON.parse(
  fs.readFileSync(path.join(specialistFolder, "private-manifest.json"), "utf8"),
);
function observeSpecialistCall(call: () => unknown): unknown {
  try {
    return { value: JSON.stringify(call()) };
  } catch (error) {
    assert.ok(
      error &&
        typeof error === "object" &&
        "message" in error &&
        "name" in error,
    );
    return { name: error.name, message: error.message };
  }
}
for (const [family, entry] of Object.entries(privateSpecialistHistory)) {
  test(`private ${family}: exact payload capability, validation and descriptor match history`, () => {
    const source = fs.readFileSync(
      path.join(specialistFolder, family + ".js.txt"),
    );
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      entry.sha256,
    );
    const context = {
      module: { exports: {} },
      require(specifier: string): unknown {
        if (specifier === "../dist/core/catalog")
          return load("./src/dist/core/catalog");
        const name = specifier.slice(2);
        const bytes = fs.readFileSync(
          path.join(specialistFolder, name + ".js.txt"),
        );
        const dependency = specialistHistory[name];
        assert.ok(dependency);
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          dependency.sha256,
        );
        const nested = { module: { exports: {} } };
        vm.runInNewContext(bytes.toString("utf8"), nested);
        return nested.module.exports;
      },
    };
    vm.runInNewContext(source.toString("utf8"), context, {
      filename: entry.path,
    });
    const previous = context.module.exports as PrivateSpecialist;
    const current = load("./" + entry.path) as PrivateSpecialist;
    const selection = family === "selection-rules-internal";
    const binding = selection
      ? { version: 1, service: "selection-rules" }
      : {
          version: 1,
          session: "owned-session",
          stagePaths: ["/owned/baseline.smt"],
          maxBytes: 1024,
          workBudgetMs: 1000,
          manifest: { version: 1, scope: "durable", bodies: [{}] },
        };
    const examples: Record<string, unknown> = selection
      ? {
          "selection.rule.define_internal": {
            definition: catalog["selection.rule.define"]?.example,
            _trustedBinding: binding,
          },
          "selection.rule.inspect_internal": {
            manifest: {},
            _trustedBinding: binding,
          },
          "selection.rule.resolve_internal": {
            manifest: {},
            _trustedBinding: binding,
          },
          "selection.rule.check_internal": {
            manifest: {},
            _trustedBinding: binding,
          },
        }
      : {
          "measure.baseline.capture_internal": {
            bodies: [{ role: "body", body: "owned-body" }],
            frame: "assembly",
            scope: "durable",
            _trustedBinding: binding,
          },
          "measure.baseline.compare_internal": {
            baseline: {
              version: 1,
              scope: "durable",
              owner: "a".repeat(64),
              id: "owned",
              sha256: "b".repeat(64),
            },
            bodies: [{ role: "body", body: "owned-body" }],
            tolerances: { volume: "0 cm^3", length: "0 cm", angle: "0 rad" },
            _trustedBinding: binding,
          },
        };
    const authorize = (
      policy: PrivateSpecialist,
      operation: string,
      data: unknown,
    ) =>
      selection ? policy.authorize(operation, data) : policy.authorize(data);
    for (const [operation, example] of Object.entries(examples)) {
      assert.equal(current.isInternal(operation), true);
      assert.equal(previous.isInternal(operation), true);
      for (const { label, data } of specialistInputs(example)) {
        const observe = (policy: PrivateSpecialist) => {
          const payload: unknown = structuredClone(data),
            before = structuredClone(payload);
          const denied = observeSpecialistCall(() =>
            policy.validateInternal(operation, payload),
          );
          const authorized = observeSpecialistCall(() =>
            authorize(policy, operation, payload),
          );
          const validated = observeSpecialistCall(() =>
            policy.validateInternal(operation, payload),
          );
          const cloned = observeSpecialistCall(() =>
            policy.validateInternal(operation, structuredClone(payload)),
          );
          assert.deepEqual(payload, before);
          return { denied, authorized, validated, cloned };
        };
        assert.deepEqual(
          observe(current),
          observe(previous),
          operation + " " + label,
        );
      }
      const payload = structuredClone(example);
      authorize(current, operation, payload);
      assert.ok(current.validateInternal(operation, payload));
      assert.throws(
        () => current.validateInternal(operation, structuredClone(payload)),
        /owned coordinator capability/,
      );
      if (selection) {
        const other = Object.keys(examples).find((key) => key !== operation);
        assert.ok(other);
        assert.throws(
          () => current.validateInternal(other, payload),
          /owned coordinator capability/,
        );
      }
    }
    assert.equal(
      current.isInternal("unknown.operation"),
      previous.isInternal("unknown.operation"),
    );
  });
}

test(
  "specialist migration preserves exact generated artifacts through real public and private composition",
  { timeout: 180000 },
  () => {
    const operations = Object.values(specialistOperations)
      .flat()
      .filter((operation) => operation !== "measure.baseline.inspect");
    assert.equal(operations.length, 15);
    const script = `
    const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
    const Module = require('node:module');
    const root = process.cwd(), folder = path.join(root, 'tests/fixtures/modeling-specialist-history');
    const entries = {...JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'))), ...JSON.parse(fs.readFileSync(path.join(folder, 'private-manifest.json')))};
    const sources = new Map(Object.entries(entries).map(([name, entry]) => {
      const source = fs.readFileSync(path.join(folder, name + '.js.txt'));
      if (crypto.createHash('sha256').update(source).digest('hex') !== entry.sha256) throw Error('Historical source changed: ' + name);
      return [path.join(root, entry.path), source.toString('utf8')];
    }));
    if (process.argv[1] === 'historical') {
      const original = Module._load, cached = new Map();
      Module._load = function(request, parent, isMain) {
        const filename = Module._resolveFilename(request, parent, isMain);
        if (!sources.has(filename)) return original.call(this, request, parent, isMain);
        if (!cached.has(filename)) {
          const historical = new Module(filename, parent);
          historical.filename = filename;
          historical.paths = Module._nodeModulePaths(path.dirname(filename));
          cached.set(filename, historical);
          historical._compile(sources.get(filename), filename);
        }
        return cached.get(filename).exports;
      };
    }
    (async () => {
      const {catalog, prepareCadScript} = require(path.join(root, 'src/cad'));
      const {admissionContext, prepareCoordinatedModelingProgram} = await import(require('node:url').pathToFileURL(path.join(root, 'tests/modeling-admission-fixtures.ts')));
      const reports = [];
      for (const operation of JSON.parse(process.argv[2])) {
        const coordinated = operation.startsWith('selection.rule.') || operation.startsWith('measure.baseline.');
        const artifact = coordinated ? await prepareCoordinatedModelingProgram(operation) : prepareCadScript(operation, catalog[operation].example, admissionContext);
        reports.push({operation, artifactHash: artifact.artifactHash, sourceHash: artifact.sha256, units: artifact.units.length});
      }
      process.stdout.write(JSON.stringify(reports));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
    const observe = (mode: string): unknown =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--experimental-strip-types",
            "-e",
            script,
            mode,
            JSON.stringify(operations),
          ],
          { cwd: root, encoding: "utf8", timeout: 80000 },
        ),
      );
    assert.deepEqual(observe("current"), observe("historical"));
  },
);
