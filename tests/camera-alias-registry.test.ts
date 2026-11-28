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
    ],
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
            ? { ...r, members: [...r.members, ...plan.contextMembers] }
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
      assert.ok(!script.includes(`def ${name}(`), name);
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
