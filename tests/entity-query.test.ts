import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  ModelingApi,
  Manual,
  NativeRequest,
} from "./modeling-unit-test-support";
import type { CliPorts } from "./cad-test-support";
const load = createRequire(
  path.join(process.cwd(), "tests/entity-query.test.ts"),
);
const { validateCad, buildCadScript, executeCad, catalog } = load(
  "../src/cad",
) as Omit<ModelingApi, "executeCad"> & {
  executeCad(
    client: unknown,
    operation: string,
    data: unknown,
    context: unknown,
  ): Promise<unknown>;
};
const { main } = load("../src/cli") as {
  main(words: string[], ports: CliPorts): Promise<number>;
};
const { validateBatch } = load("../src/batch") as {
  validateBatch(
    value: unknown,
    catalog: ModelingApi["catalog"],
  ): { success: boolean };
};
const fixture = load("./fixtures/gm03-native.json") as {
  operations: { operation: string; data: unknown }[];
};
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
const { detail } = load("../src/help") as {
  detail(...words: string[]): string;
};
const { manuals } = load("../src/help-manual") as {
  manuals: Record<string, Manual>;
};

test("GM03 all query variants pass the actual CLI validator and script builder", () => {
  const data = {
    schemaVersion: 1,
    kind: "edge",
    scope: { body: "Body", occurrence: "Parent:1+Part:1" },
    instances: true,
    frame: { datum: "mount", occurrence: "Parent:1+Part:1" },
    expect: { min: 0, max: 20 },
    groupBy: [
      "kind",
      "geometry",
      "component",
      "occurrence",
      "body",
      "radius",
      "length",
      "axis",
      "level",
    ],
    filters: {
      geometry: "circle",
      radius: { min: "2 mm", max: "3 mm" },
      length: { max: "1 mm" },
      axis: [0, 0, -1],
      position: ["0 mm", "0 mm", "0 mm"],
      bbox: {
        min: ["-1 cm", "-1 cm", "-1 cm"],
        max: ["1 cm", "1 cm", "1 cm"],
        mode: "intersects",
      },
      level: { axis: "z", at: "min", value: { max: "0 mm" } },
      adjacency: { kind: "face", filters: { geometry: "cylinder" }, expect: 1 },
      tolerance: "0.01 mm",
      angleTolerance: "0.1 deg",
    },
  };
  for (const operation of ["entity.find", "entity.stats"]) {
    assert.ok(validateCad(operation, data).readOnly);
    const script = buildCadScript(operation, data, { doc: "offline" });
    assert.match(script, /def _entity_query/);
    assert.match(script, /native-to-root-to-output/);
  }
  for (const geometry of [
    "plane",
    "cylinder",
    "cone",
    "sphere",
    "torus",
    "circle",
    "ellipse",
    "line",
    "point",
    "nurbsCurve",
    "nurbsSurface",
  ]) {
    validateCad("entity.stats", { filters: { geometry } });
  }
  for (const frame of [
    "context",
    "component",
    "root",
    { component: "Part" },
    { occurrence: "Part:1" },
    { sketch: "Section" },
    { datum: "Mount" },
  ])
    validateCad("entity.inspect", { ref: "body", frame });
  for (const [operation, key] of [
    ["model.fillet", "radius"],
    ["model.chamfer", "distance"],
  ] as const) {
    validateCad(operation, {
      query: { filters: { length: "1 mm" }, expect: 1 },
      [key]: "0.1 mm",
    });
    validateCad(operation, { edges: ["edge"], [key]: "0.1 mm" });
  }
  const reference = {
    query: { kind: "edge", filters: { length: { max: "1 mm" } } },
  };
  validateCad("measure.length", { ref: reference });
  validateCad("check", {
    measurement: { operation: "measure.length", data: { ref: reference } },
    expected: "1 mm",
  });
  validateCad("appearance.assign", {
    refs: [{ query: { kind: "body", expect: 1 } }],
    id: "observed-local-style",
  });
  assert.throws(() =>
    validateCad("measure.length", { ref: { query: { expect: true } } }),
  );
  assert.throws(() =>
    validateCad("appearance.assign", { refs: [{ query: null }], id: "style" }),
  );
});

test("GM03 malformed queries are refused before config/backend creation by the real CLI", async () => {
  const invalid = [
    { expect: true },
    { expect: { min: 3, max: 1 } },
    { expect: {} },
    { instances: 1 },
    { schemaVersion: 2 },
    { filters: { axis: [0, 0, 0] } },
    { filters: { radius: 2 } },
    { filters: { position: ["0", "1 mm", "2 mm"] } },
    { filters: { length: { nominal: "1 mm" } } },
    { filters: { bbox: { min: ["0 mm"], max: ["1 mm"] } } },
    { filters: { level: { axis: "q", value: "1 mm" } } },
    { filters: { adjacency: { kind: "feature" } } },
    {
      filters: {
        adjacency: { kind: "face", filters: { adjacency: { kind: "edge" } } },
      },
    },
    { filters: { adjacency: { kind: "edge", refs: [] } } },
    { unique: true, expect: 1 },
    { groupBy: ["axis", "axis"] },
    { frame: { sketch: "S", occurrence: "P:1" } },
    { scope: { body: "B", feature: "F" } },
    { scope: { body: "B" }, component: "P" },
  ];
  let calls = 0;
  const forbidden = () => {
    calls++;
    throw new Error("Offline test attempted backend/config access");
  };
  for (const data of invalid) {
    let error = "";
    const status = await main(
      [
        "entity",
        "stats",
        "--doc",
        "offline",
        "--data",
        JSON.stringify(data),
        "--preview",
      ],
      {
        loadConfig: forbidden,
        McpClient: class {
          constructor() {
            forbidden();
          }
        },
        stdout: { write() {} },
        stderr: {
          write(s: string) {
            error += s;
          },
        },
        setExitCode() {},
      },
    );
    assert.notEqual(status, 0, JSON.stringify(data));
    assert.ok(error);
  }
  for (const data of [
    { radius: "1 mm" },
    { edges: [], radius: "1 mm" },
    { edges: ["e"], query: { expect: 1 }, radius: "1 mm" },
    { query: {}, radius: "1 mm" },
    { query: { kind: "face", expect: 1 }, radius: "1 mm" },
    { query: { expect: 1 }, radius: "1 mm", tangentChain: "false" },
  ]) {
    assert.throws(() => validateCad("model.fillet", data));
  }
  assert.equal(calls, 0);
});

test("GM03 namespaced attribute predicates require explicit owner and occurrence context", async () => {
  const native = {
    group: "fixture.roles",
    name: "role",
    value: "physical",
    owner: "native",
  };
  const exactProxy = {
    group: "fixture.roles",
    name: "role",
    value: "instance",
    owner: "proxy",
  };
  const occurrence = {
    group: "fixture.roles",
    name: "site",
    value: "north",
    owner: "occurrence",
  };
  assert.doesNotThrow(() =>
    validateCad("entity.find", {
      kind: "body",
      filters: { attributes: [native] },
    }),
  );
  assert.doesNotThrow(() =>
    validateCad("entity.find", {
      kind: "body",
      filters: {
        attributes: [
          {
            group: "fixture.roles",
            name: "empty-value",
            value: "",
            owner: "native",
          },
        ],
      },
    }),
  );
  assert.doesNotThrow(() =>
    validateCad("entity.stats", {
      kind: "body",
      instances: true,
      filters: { attributes: [occurrence] },
    }),
  );
  assert.doesNotThrow(() =>
    validateCad("entity.find", {
      kind: "occurrence",
      filters: { attributes: [occurrence] },
    }),
  );
  assert.doesNotThrow(() =>
    validateCad("entity.find", {
      kind: "body",
      instances: true,
      filters: {
        adjacency: { kind: "face", filters: { attributes: [exactProxy] } },
      },
    }),
  );
  for (const filters of [
    { attributes: {} },
    { attributes: [] },
    { attributes: [{ group: "g", name: "n", value: "v" }] },
    { attributes: [{ group: " ", name: "n", value: "v", owner: "native" }] },
    { attributes: [{ group: "g", name: "", value: "v", owner: "native" }] },
    { attributes: [{ group: "g", name: "n", value: 1, owner: "native" }] },
    { attributes: [{ group: "g", name: "n", value: "v", owner: "entity" }] },
    {
      attributes: [
        {
          group: "g",
          name: "n",
          value: "v",
          owner: "native",
          fallback: "proxy",
        },
      ],
    },
  ])
    assert.throws(() => validateCad("entity.find", { kind: "body", filters }));
  assert.throws(
    () =>
      validateCad("entity.find", {
        kind: "body",
        filters: { attributes: [occurrence] },
      }),
    /occurrence scope.*instances/,
  );
  assert.throws(
    () =>
      validateCad("entity.stats", {
        kind: "component",
        instances: true,
        filters: { attributes: [occurrence] },
      }),
    /not valid for component/,
  );

  let calls = 0;
  const forbidden = () => {
    calls++;
    throw new Error("offline attribute preflight reached backend/config");
  };
  for (const data of [
    {
      kind: "body",
      filters: {
        attributes: [{ group: "g", name: "n", value: "v", owner: "entity" }],
      },
    },
    { kind: "body", filters: { attributes: [occurrence] } },
    {
      kind: "component",
      instances: true,
      filters: { attributes: [occurrence] },
    },
  ]) {
    let error = "";
    const status = await main(
      [
        "entity",
        "find",
        "--doc",
        "offline",
        "--data",
        JSON.stringify(data),
        "--preview",
      ],
      {
        loadConfig: forbidden,
        McpClient: class {
          constructor() {
            forbidden();
          }
        },
        stdout: { write() {} },
        stderr: {
          write(s: string) {
            error += s;
          },
        },
        setExitCode() {},
      },
    );
    assert.notEqual(status, 0);
    assert.ok(error);
  }
  assert.equal(calls, 0);
});

test("entity query catalog help states exact attribute owner/context contract", () => {
  const find = detail("entity", "find");
  const stats = detail("entity", "stats");
  assert.match(find, /attributes/);
  assert.match(find, /native/);
  assert.match(find, /proxy/);
  assert.match(find, /occurrence/);
  assert.match(find, /no proxy fallback/);
  assert.match(find, /instances:true/);
  assert.match(stats, /attributes/);
  assert.match(stats, /owner fallback/);
});

test("GM03 executor preserves expectation failure, metadata, and readOnly transport", async () => {
  let request: NativeRequest | undefined;
  let calls = 0;
  const client = {
    callTool: async (r: NativeRequest) => {
      calls++;
      request = r;
      return {
        text:
          "FMCAD_RESULT " +
          JSON.stringify({
            success: false,
            operation: "entity.stats",
            result: {
              schemaVersion: 1,
              success: false,
              status: "fail",
              count: 2,
              refs: [{ token: "a" }, { token: "b" }],
              associativity: "snapshot",
              documentIdentity: { creationId: "offline" },
              units: { length: "cm" },
              frame: "root",
            },
            created: [],
          }),
      };
    },
  };
  const result = record(
    await executeCad(
      client,
      "entity.stats",
      { expect: 1 },
      { doc: "offline", docId: "offline-creation", docFileId: "offline-file" },
    ),
  );
  assert.equal(calls, 1);
  assert.ok(request);
  assert.match(request.object.script, /offline-creation/);
  assert.match(request.object.script, /offline-file/);
  assert.equal(request.object.readOnly, true);
  assert.equal(result["success"], false);
  assert.equal(record(result["result"])["count"], 2);
  assert.equal(record(result["result"])["associativity"], "snapshot");
  assert.equal(result["status"], "fail");
  assert.equal(record(result["documentIdentity"])["creationId"], "offline");
  assert.equal(record(result["units"])["length"], "cm");
  assert.equal(result["frame"], "root");
});

test("GM03 owner manuals are discoverable through the real help renderer", () => {
  for (const operation of [
    "entity.find",
    "entity.inspect",
    "entity.stats",
    "model.fillet",
    "model.chamfer",
  ]) {
    const manual = manuals[operation];
    assert.ok(manual, operation);
    assert.ok(
      manual.sections.some((section) => /Return Contract/.test(section.title)),
      operation,
    );
    assert.match(detail(...operation.split(".")), /GM03/);
    for (const example of manual.examples) validateCad(operation, example.data);
  }
});

test("GM03 native handoff uses valid batch operations and actual nested validators", () => {
  const result = validateBatch(
    { ...fixture, runId: "gm03-offline-validation" },
    catalog,
  );
  assert.equal(result["success"], true, JSON.stringify(result));
  for (const step of fixture.operations) {
    // Whole-value $ref objects remain symbolic here; dimensional values in this
    // fixture are explicit strings. Runtime resolves every ref before execution.
    validateCad(step.operation, step.data);
  }
});

test("GM03 isolated SDK fixture executes real resolver and modeling integration", () => {
  const result = spawnSync(
    "python3",
    ["-B", "tests/entity_query_test.py", "-b"],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.ifError(result.error);
  assert.equal(result["status"], 0, result.stdout + result.stderr);
});
