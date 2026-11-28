import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { planCameraAlias } from "../packages/node-adapters/src/python/camera-alias-registry.js";
import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact.js";

const root = process.env["FMCAD_CONTEXT_TEST_ROOT"] ?? process.cwd();
const load = createRequire(path.join(root, "package.json"));
const base = "./packages/node-adapters/dist/python/";
const {
  cameraSaveHandlerPlan: h,
  cameraSaveCanonicalSources: refs,
  cameraSaveTypingSources: types,
} = load(base + "camera-read-registry.js");
const { planCameraSaveContext } = load(base + "camera-context-registry.js");
const { cameraComponentNamePlan } = load(base + "camera-component-registry.js");
const { prepareCanonicalRegisteredPayload } = load(
  base + "registered-payload.js",
);
const { eraseRegisteredPython } = load(base + "registered-erasure.js");
const checker = load(base + "checker.js").createPythonChecker({
  typingRoot: path.join(root, "dist/runtime/python/typing"),
  definitionsRoot: path.join(root, "dist/runtime/python/typing"),
});

type Observation = { name: string; raw: string };
const attr = (v: unknown) => JSON.stringify(v);
const part = attr({ kind: "component", token: "part-token", name: "outdated" });
const scopedQuery = {
  query: { kind: "component", scope: { component: "root" } },
};

const cases: {
  label: string;
  raw: string;
  attributes?: Record<string, string>;
  observed?: Observation[];
  wantedSignal?: string[];
  stale?: boolean;
  status?: string;
  check?: boolean;
  absent?: string[];
  emptyCollections?: boolean;
  instanceBody?: boolean;
}[] = [
  {
    label: "root",
    raw: attr("root"),
    status: "ok",
    check: true,
    absent: ["_camera_alias_token", "_entity_query"],
  },
  {
    label: "token",
    raw: part,
    status: "ok",
    check: true,
    absent: ["_camera_alias_complex_name", "_entity_query"],
  },
  {
    label: "occurrence path",
    raw: attr({ kind: "occurrence", token: "occ-token", path: "Part:1" }),
    status: "ok",
  },
  {
    label: "persisted occurrence",
    raw: attr({
      kind: "occurrence",
      token: "occ-token",
      path: "Part:1",
      component: JSON.parse(part),
    }),
    status: "ok",
    check: true,
  },
  { label: "plain name", raw: attr("Part"), status: "ok", check: true },
  {
    label: "new nested attribute",
    raw: attr("view"),
    attributes: { view: part },
    wantedSignal: ["view", part],
  },
  {
    label: "known nested attribute",
    raw: attr("view"),
    attributes: { view: part },
    observed: [{ name: "view", raw: part }],
    status: "ok",
  },
  {
    label: "changed nested attribute",
    raw: attr("view"),
    attributes: { view: attr("root") },
    observed: [{ name: "view", raw: part }],
    stale: true,
  },
  { label: "malformed raw JSON", raw: "{", status: "JSONDecodeError" },
  {
    label: "scoped name",
    raw: attr({ kind: "component", name: "view", component: "root" }),
    attributes: { view: part },
    observed: [{ name: "view", raw: part }],
    status: "ok",
    check: true,
  },
  {
    label: "profile sketch/index",
    raw: attr({ kind: "profile", sketch: "Section", index: 1 }),
    status: "ok",
  },
  {
    label: "query scope",
    raw: attr(scopedQuery),
    status: "ok",
    check: true,
    absent: [
      "_entity_neighbors",
      "_entity_attribute_owner",
      "_entity_frame_target",
      "_entity_find",
      "_cad_resolve_basic_reference",
      "resolve",
      "_scope",
      "_entities",
      "_proxy",
      "_camera_alias_target",
      "_cad_context_entities",
      "_cad_context_proxy",
      "_cad_context_scope",
      "_cad_dedup",
      "_cad_parameter_info",
      "_cad_geometry",
      "_cad_direction",
      "_entity_owner_matrix",
      "_entity_occurrence_matrix",
      "_entity_matrix",
      "point",
    ],
  },
  {
    label: "unscoped component query",
    raw: attr({ query: { kind: "component", filters: { name: "Part" } } }),
    status: "ok",
    check: true,
    absent: [
      "resolve",
      "_scope",
      "_entities",
      "_proxy",
      "_camera_alias_complex_name",
      "_cad_parameter_info",
      "point",
    ],
  },
  {
    label: "reference kind supplies query kind",
    raw: attr({ kind: "component", query: { filters: { name: "Part" } } }),
    status: "ok",
    absent: ["resolve", "_scope", "_entities", "_proxy"],
  },
  {
    label: "query rejects invalid filters before invalid scope",
    raw: attr({
      query: {
        kind: "component",
        filters: { bad: "filter" },
        scope: { invalid: 1 },
      },
    }),
    status: "ValueError",
    absent: ["resolve", "_scope", "_entities", "_proxy"],
  },
  {
    label: "null explicit component scope",
    raw: attr({ query: { kind: "component", scope: { component: null } } }),
    status: "ok",
    absent: ["resolve", "_entities", "_cad_context_entities"],
  },
  {
    label: "default face query",
    raw: attr({ query: {} }),
    status: "ValueError",
    check: true,
    absent: [
      "_entities",
      "edge",
      "vertex",
      "profile",
      "resolve",
      "_cad_resolve_basic_reference",
      "_scope",
      "_camera_alias_target",
      "point",
    ],
  },
  {
    label: "invalid root scope guard",
    raw: attr({ query: { kind: "component", scope: { unexpected: "x" } } }),
    status: "ValueError",
  },
  {
    label: "conflicting root scopes",
    raw: attr({ query: { kind: "component", scope: {}, component: "root" } }),
    status: "ValueError",
  },
  {
    label: "unscoped occurrence query",
    raw: attr({ query: { kind: "occurrence", frame: "component" } }),
    status: "ok",
    check: true,
    absent: [
      "resolve",
      "_entities",
      "_cad_context_entities",
      "_cad_context_scope",
    ],
  },
  {
    label: "assembly instances query",
    raw: attr({
      query: { kind: "component", instances: true, filters: { name: "Part" } },
    }),
    status: "ok",
    check: true,
    absent: ["resolve", "_entities", "_cad_context_scope"],
  },
  {
    label: "instance body query creates the canonical proxy",
    raw: attr({
      query: {
        kind: "body",
        instances: true,
        frame: "component",
        filters: { name: "instance-body" },
      },
    }),
    instanceBody: true,
    status: "ok",
    check: true,
    absent: ["resolve", "_entities", "edge", "profile"],
  },
  ...[
    "sketch",
    "feature",
    "plane",
    "axis",
    "point",
    "edge",
    "vertex",
    "profile",
  ].map((kind) => ({
    label: `fixed ${kind} query`,
    raw: attr({
      query: { kind, frame: "component", filters: { name: "unmatched" } },
    }),
    emptyCollections: true,
    status: "ValueError",
    check: true,
    absent: [
      "resolve",
      "_entities",
      "_scope",
      "_camera_alias_target",
      "_cad_parameter_info",
    ],
  })),
  {
    label: "parameter query",
    raw: attr({ kind: [], query: { kind: "parameter" } }),
    status: "ValueError",
    check: true,
    absent: ["resolve", "_entities", "_proxy", "_cad_resolve_basic_reference"],
  },
  {
    label: "query expectation diagnostics",
    raw: attr({ query: { kind: "component", filters: { name: "missing" } } }),
    status: "ValueError",
  },
  {
    label: "query nested in scope",
    raw: attr({ kind: "body", name: "same", component: scopedQuery }),
    status: "ok",
  },
  {
    label: "query in nested attribute",
    raw: attr("view"),
    attributes: { view: attr(scopedQuery) },
    observed: [{ name: "view", raw: attr(scopedQuery) }],
    status: "ok",
  },
  {
    label: "attribute filter diagnostics",
    raw: attr({
      query: {
        kind: "component",
        filters: {
          attributes: [
            { group: "g", name: "missing", value: "v", owner: "native" },
          ],
        },
      },
    }),
    status: "ValueError",
    absent: ["_entity_neighbors", "_entity_frame_target"],
  },
  {
    label: "adjacency and frame",
    raw: attr({
      query: {
        kind: "body",
        frame: { component: "root" },
        filters: { adjacency: { kind: "edge", expect: 0 } },
      },
    }),
    status: "ok",
    check: true,
  },
  {
    label: "query requests unknown scoped alias",
    raw: attr({ query: { kind: "component", scope: { component: "view" } } }),
    attributes: { view: part },
    wantedSignal: ["view", part],
  },
  {
    label: "query resumes chain of scoped aliases",
    raw: attr({ query: { kind: "component", scope: { component: "view" } } }),
    attributes: { view: attr("inner"), inner: part },
    observed: [
      { name: "view", raw: attr("inner") },
      { name: "inner", raw: part },
    ],
    status: "ok",
  },
];
for (const c of cases)
  test(`camera alias ${c.label}`, async () => {
    const plan = planCameraAlias(c.raw, c.observed),
      ctx = planCameraSaveContext({}),
      component = cameraComponentNamePlan("resume-alias");
    const asLocal = (r: { filename: string }) => ({
      ...r,
      filename: path.relative(root, path.resolve(r.filename)),
    });
    const artifact: PreparedPythonArtifact = prepareCanonicalRegisteredPayload(
      root,
      [
        ...h.definitions,
        ...ctx.definitions,
        ...component.definitions,
        ...plan.definitions,
      ],
      [
        ...refs,
        ...ctx.references.map((r: { members?: string[] }) =>
          r.members
            ? {
                ...r,
                members: [...r.members, ...plan.contextMembers],
                typingMembers: plan.contextTypingMembers,
              }
            : r,
        ),
        ...component.references,
        ...plan.references.map(asLocal),
      ],
      [
        "adsk",
        "adsk.fusion",
        ...plan.roots,
        ...ctx.roots,
        ...component.roots,
        ...h.roots,
      ],
      {},
      {
        id: "wrapper",
        filename: "<fmcad-wrapper>",
        role: "wrapper",
        source: `def run(_context: str):\n    ctx = CadContext("Test")\n    print(${plan.resolverSymbol}(ctx, ${JSON.stringify(c.raw)}))\n`,
      },
      {},
      [
        ...types,
        ...ctx.typingReferences,
        ...component.typingReferences,
        ...plan.typingReferences.map(asLocal),
      ].filter((r) => r.importName !== "typing.TYPE_CHECKING"),
    );
    const script: string = eraseRegisteredPython(root, artifact.script);
    for (const name of c.absent ?? [])
      assert.doesNotMatch(
        script,
        new RegExp(`^(?:\\s*def ${name}\\(|${name} =)`, "m"),
        name,
      );
    const run = spawnSync("python3", ["-B", "tests/camera_alias_oracle.py"], {
      encoding: "utf8",
      input: JSON.stringify({
        ...c,
        attributes: c.attributes ?? {},
        aliasBindings: plan.aliasBindings,
        resolverSymbol: plan.resolverSymbol,
        script,
      }),
    });
    assert.equal(run.status, 0, run.stderr);
    if (c.check) {
      const report = await checker.check({
        artifact,
        context: { kind: "raw", entrypoint: "run" },
      });
      assert.equal(report.status, "passed", JSON.stringify(report.diagnostics));
    }
  });
