import { createRequire } from "node:module";
import type { Descriptor, ModelingApi } from "./modeling-unit-test-support";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
const load = createRequire(
  path.join(process.cwd(), "tests/feature-rework.test.ts"),
);
test.after(load("./fixtures/fake-wsl-platform.cjs")());
const { descriptors, validate, configure } =
  load("../src/feature-rework") as {
    descriptors: Record<string, Descriptor>;
    validate(op: string, data: unknown): unknown;
    configure(catalog: Record<string, unknown>): void;
  };

const inspect = {
  schemaVersion: 1,
  frame: "component",
  feature: { token: "extrude-feature-token" },
};
const edit = {
  schemaVersion: 1,
  frame: "component",
  feature: { token: "extrude-feature-token" },
  entries: [
    { role: "startOffset", expression: "2 mm" },
    { role: "distance", expression: "10 mm" },
  ],
};

test("GM09 rework descriptors are self-contained and clearly marked", () => {
  assert.equal(descriptors["feature.inspect"]!.readOnly, true);
  assert.equal(descriptors["feature.edit"]!.readOnly, false);
  for (const operation of ["feature.inspect", "feature.edit"])
    assert.equal(descriptors[operation]!.featureRework, true);
  validate("feature.inspect", inspect);
  validate("feature.edit", edit);
  validate("feature.edit", {
    ...inspect,
    extent: { mode: "distance", distance: "10 mm" },
    preview: true,
  });
  validate("feature.edit", { ...inspect, name: "Renamed" });
  validate("feature.edit", {
    ...inspect,
    extent: { mode: "twoSideAngle", angle: "90 deg", angleTwo: "45 deg" },
    preview: true,
  });
  validate("feature.edit", {
    ...inspect,
    extent: { mode: "throughAll", reverse: true },
    preview: true,
  });
});

test("GM09 validator no-ops on foreign operations and rejects malformed payloads", () => {
  validate("model.extrude", { profile: "p" });
  validate("surface.check", {});
  const cases: [string, Record<string, unknown>][] = [
    ["feature.inspect", { ...inspect, schemaVersion: 2 }],
    ["feature.inspect", { ...inspect, frame: "root" }],
    [
      "feature.edit",
      { schemaVersion: 1, frame: "component", feature: { token: "x" } },
    ],
    ["feature.edit", { ...inspect, preview: "yes" }],
    ["feature.edit", { ...inspect, name: "" }],
    ["feature.edit", { ...inspect, entries: [{ expression: "2 mm" }] }],
    [
      "feature.edit",
      { ...inspect, entries: [{ role: "", expression: "2 mm" }] },
    ],
    [
      "feature.edit",
      {
        ...inspect,
        entries: [
          { name: "d1", role: "distance", expression: "2 mm", junk: true },
        ],
      },
    ],
    ["feature.edit", { ...inspect, entries: [{ name: "d1", expression: 5 }] }],
    ["feature.edit", { ...inspect, entries: [] }],
    ["feature.edit", { ...inspect, extent: { mode: "symmetric" } }],
    [
      "feature.edit",
      { ...inspect, extent: { mode: "toEntity", distance: "1 mm" } },
    ],
    [
      "feature.edit",
      {
        ...inspect,
        extent: { mode: "distance", distance: "1 mm", target: "face" },
      },
    ],
    [
      "feature.edit",
      {
        ...inspect,
        extent: { mode: "distance", distance: "1 mm", distanceTwo: "2 mm" },
      },
    ],
    [
      "feature.edit",
      {
        ...inspect,
        extent: { mode: "distance", distance: "1 mm", taperTwo: "1 deg" },
      },
    ],
    [
      "feature.edit",
      {
        ...inspect,
        extent: { mode: "distance", distance: "1 mm", isFullLength: true },
      },
    ],
    [
      "feature.edit",
      { ...inspect, extent: { mode: "helix", distance: "1 mm" } },
    ],
    [
      "feature.edit",
      {
        ...inspect,
        extent: { mode: "distance", distance: "1 mm", direction: "up" },
      },
    ],
    [
      "feature.edit",
      { ...inspect, extent: { mode: "distance", distance: "" } },
    ],
    [
      "feature.edit",
      { ...inspect, extent: { mode: "twoSideAngle", angle: "90 deg" } },
    ],
    [
      "feature.edit",
      { ...inspect, extent: { mode: "twoSidesToEntity", target: "face" } },
    ],
  ];
  for (const [operation, data] of cases)
    assert.throws(
      () => validate(operation, data),
      `${operation}: ${JSON.stringify(data)}`,
    );
});

test("operationChange CLI validation accepts valid modes and rejects invalid/mixed inputs", () => {
  const { validateCad } = load("../src/cad") as ModelingApi;
  const base = {
    schemaVersion: 1,
    frame: "component",
    feature: { token: "extrude-feature-token" },
  };
  for (const value of ["newBody", "join", "cut", "intersect"]) {
    const change: {
      expected: string;
      value: string;
      expectedResultBodyCount: number;
      participants?: { token: string }[];
    } = { expected: "newBody", value, expectedResultBodyCount: 1 };
    if (value !== "newBody") change.participants = [{ token: "body-token" }];
    assert.doesNotThrow(() =>
      validateCad("feature.edit", { ...base, operationChange: change }),
    );
  }
  const invalid = [
    { expected: "newBody", value: "union", expectedResultBodyCount: 1 },
    { expected: "newBody", value: "newBody", expectedResultBodyCount: 0 },
    { expected: "newBody", value: "join", expectedResultBodyCount: 1 },
    {
      expected: "newBody",
      value: "newBody",
      expectedResultBodyCount: 1,
      participants: [],
    },
    {
      expected: "newBody",
      value: "cut",
      expectedResultBodyCount: 1,
      participants: [],
    },
    {
      expected: "newBody",
      value: "join",
      expectedResultBodyCount: 1,
      participants: [],
      junk: true,
    },
  ];
  for (const operationChange of invalid)
    assert.throws(() =>
      validateCad("feature.edit", { ...base, operationChange }),
    );
  assert.throws(
    () =>
      validateCad("feature.edit", {
        ...base,
        name: "Mixed",
        operationChange: {
          expected: "newBody",
          value: "newBody",
          expectedResultBodyCount: 1,
        },
      }),
    /cannot be combined/,
  );
  assert.throws(
    () =>
      validateCad("feature.edit", {
        ...base,
        operationChange: {
          expected: "newBody",
          value: "newBody",
          expectedResultBodyCount: 1,
        },
        surprise: true,
      }),
    /Unknown CAD inputs/,
  );
});

test("nativeEdits is an in-place family object, mutually exclusive and nonempty", () => {
  const { validateCad } = load("../src/cad") as ModelingApi;
  const base = {
    schemaVersion: 1,
    frame: "component",
    feature: { token: "feature-token" },
  };
  for (const nativeEdits of [
    { profile: { token: "profile-token" } },
    { axis: { token: "axis-token" } },
    { edgeSets: [{ index: 0, radius: "2 mm" }] },
    { holeType: { type: "counterbore", diameter: "5 mm", depth: "2 mm" } },
    {
      entities: [{ token: "body-token" }],
      mirrorPlane: { token: "plane-token" },
    },
    {
      sections: [{ token: "profile-a" }, { token: "profile-b" }],
      isClosed: false,
    },
  ])
    assert.doesNotThrow(() =>
      validateCad("feature.edit", { ...base, nativeEdits }),
    );
  for (const nativeEdits of [null, [], {}, "profile"]) {
    assert.throws(
      () => validateCad("feature.edit", { ...base, nativeEdits }),
      /nativeEdits must be a nonempty object/,
    );
  }
  assert.throws(
    () =>
      validateCad("feature.edit", {
        ...base,
        entries: [{ name: "r1", expression: "2 mm" }],
        nativeEdits: { profile: "P" },
      }),
    /cannot be combined/,
  );
});

test("generic native fixture covers every mandatory feature-edit family", () => {
  const fixture = load("./fixtures/feature-edit-native.json") as {
    operations: {
      id: string;
      operation: string;
      data: Record<string, unknown>;
    }[];
  };
  const edits = fixture.operations.filter(
    (step) => step.operation === "feature.edit",
  );
  const mutating = edits.filter((step) => step.data["preview"] !== true);
  assert.deepEqual(
    mutating.map((step) => step.id),
    [
      "editExtrude",
      "editRevolve",
      "editFillet",
      "editChamfer",
      "editHole",
      "editPattern",
      "editMirror",
      "editShell",
      "editSweep",
      "editLoft",
      "editThicken",
    ],
  );
  for (const step of mutating) {
    assert.equal(step.data["schemaVersion"], 1);
    assert.equal(step.data["frame"], "component");
    assert.equal(step.data["confirm"], true);
    assert.ok(step.data["feature"]);
    assert.ok(step.data["nativeEdits"]);
    assert.doesNotThrow(
      () => load("../src/cad").validateCad("feature.edit", step.data),
      step.id,
    );
  }
  assert.ok(edits.some((step) => step.data["preview"] === true));
});

test("GM09 configure supersedes legacy descriptors exactly once", () => {
  const legacy = {
    summary: "legacy",
    required: ["feature"],
    inputs: {},
    example: {},
  };
  const catalog: Record<string, { featureRework?: boolean; summary: string }> =
    {
      "feature.inspect": legacy,
      "feature.edit": legacy,
      "model.extrude": legacy,
    };
  configure(catalog);
  assert.equal(catalog["feature.inspect"]!.featureRework, true);
  assert.equal(catalog["feature.edit"]!.featureRework, true);
  assert.equal(catalog["model.extrude"], legacy);
  const kept = catalog["feature.inspect"];
  configure(catalog);
  assert.equal(catalog["feature.inspect"], kept);
  assert.ok(!validate("feature.inspect", inspect));
  assert.ok(validate("feature.inspect", inspect) === undefined);
});
