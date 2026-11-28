import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import type { CadClient } from "../src/composition/cad-execution.js";
import type { CadContext } from "../packages/core/src/application/cad/contracts.js";

const load = createRequire(path.resolve("package.json"));
const { executeCad } = load(
  "./src/cad",
) as typeof import("../src/composition/cad-execution.js");
const context = { doc: "Target", docId: "own-id", component: "selection" };
const alias = (name: string, raw: string | null, docId = "own-id") => ({
  operation: "camera.save",
  document: "Target",
  _cameraAlias: { name, raw, docId },
});
const success = {
  success: true,
  operation: "camera.save",
  document: "Target",
  created: [],
  result: { state: { units: "cm" } },
};
function simulate(replies: readonly unknown[], target: CadContext = context) {
  const scripts: string[] = [];
  const backend: CadClient = {
    async callTool(request) {
      const reply = replies[scripts.length];
      scripts.push(request.object.script);
      if (reply instanceof Error) throw reply;
      return { text: "FMCAD_RESULT " + JSON.stringify(reply) };
    },
  };
  return { scripts, pending: executeCad(backend, "camera.save", {}, target) };
}

test("camera resumes from validated alias observations without exposing private results", async () => {
  const raw = JSON.stringify({ name: "inner" });
  const inner = JSON.stringify({ token: "persisted-token", kind: "component" });
  const attempt = simulate([
    alias("selection", raw),
    alias("inner", inner),
    success,
  ]);
  assert.deepEqual(await attempt.pending, success);
  assert.equal(attempt.scripts.length, 3);
  assert.doesNotMatch(
    attempt.scripts[0]!,
    /findEntityByToken|def _camera_resume_component_name/,
  );
  assert.match(attempt.scripts[1]!, /component alias changed/);
  assert.match(attempt.scripts[2]!, /findEntityByToken/);
  assert.match(attempt.scripts[2]!, /persisted-token/);
  for (const script of attempt.scripts.slice(1))
    assert.doesNotMatch(
      script,
      /json\.loads|_camera_alias_bindings|_CameraAliasRequired|class CadContext/,
    );
  assert.match(attempt.scripts[1]!, /if inner_raw is not None/);
  assert.doesNotMatch(attempt.scripts[2]!, /if inner_raw is not None/);
});

test("unknown names first discover only the attribute; missing aliases are revalidated before selection", async () => {
  const testRun = simulate([alias("selection", null), success]);
  assert.deepEqual(await testRun.pending, success);
  assert.equal(testRun.scripts.length, 2);
  assert.doesNotMatch(
    testRun.scripts[0]!,
    /_camera_pose|_camera_matching_names|allOccurrences/,
  );
  assert.match(testRun.scripts[1]!, /component alias changed/);
  assert.doesNotMatch(
    testRun.scripts[1]!,
    /findEntityByToken|class CadContext/,
  );
  assert.match(testRun.scripts[1]!, /_camera_pose/);
});

test("bound chain programs retain both name ambiguities, token errors, and stale-attribute refusals", () => {
  const { prepareCadScript } = load("./src/cad");
  const raw = JSON.stringify("inner"),
    inner = JSON.stringify({ kind: "component", token: "part" });
  const programs = [[], [{ name: "inner", raw: inner }]].map(
    (observed) =>
      prepareCadScript(
        "camera.save",
        {},
        { doc: "Test", docId: "document-from-test", component: "outer" },
        undefined,
        undefined,
        undefined,
        { name: "outer", docId: "document-from-test", raw, observed },
      ).script,
  );
  const run = spawnSync("python3", ["-B", "tests/camera_chain_programs.py"], {
    input: JSON.stringify({ programs, raw, inner }),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
});

test("camera refuses changed pins, unresolved cyclic aliases and missing results before any retry", async () => {
  const raw = JSON.stringify({ name: "inner" });
  for (const [replies, expected] of [
    [[alias("selection", raw, "foreign")], /mismatched continuation/],
    [[alias("different", raw)], /mismatched continuation/],
    [[alias("selection", raw), alias("selection", raw)], /Cyclic/],
    [[alias("selection", raw), new Error("lost response")], /lost response/],
  ] as const) {
    const attempt = simulate(replies);
    await assert.rejects(attempt.pending, expected);
    assert.equal(attempt.scripts.length, replies.length);
  }
});

test("internal batch component reference uses its actual resolver without a name probe", async () => {
  const attempt = simulate([success], {
    ...context,
    component: { token: "batch-token", kind: "component" },
  });
  assert.deepEqual(await attempt.pending, success);
  assert.equal(attempt.scripts.length, 1);
  assert.match(attempt.scripts[0]!, /findEntityByToken/);
  assert.doesNotMatch(attempt.scripts[0]!, /def _camera_try_component_name/);
});
