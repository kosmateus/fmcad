import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  liveScenarioArtifactRootEnv,
  scenarioArtifactRoot,
} from "./artifact-root";

function directories(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "scenario-artifact-root-"),
    ),
    firstProject = path.join(root, "worktree-a"),
    secondProject = path.join(root, "worktree-b"),
    shared = path.join(root, "campaign-artifacts");
  fs.mkdirSync(firstProject, { mode: 0o700 });
  fs.mkdirSync(secondProject, { mode: 0o700 });
  fs.mkdirSync(shared, { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, firstProject, secondProject, shared };
}

test("live worktrees resolve the same explicit artifact root independently", (t) => {
  const { firstProject, secondProject, shared } = directories(t),
    env = { [liveScenarioArtifactRootEnv]: shared };
  assert.notEqual(firstProject, secondProject);
  assert.equal(scenarioArtifactRoot(firstProject, "fusion", env), shared);
  assert.equal(scenarioArtifactRoot(secondProject, "fusion", env), shared);
});

test("default and offline artifact roots remain checkout-local", (t) => {
  const { firstProject, secondProject, shared } = directories(t),
    env = { [liveScenarioArtifactRootEnv]: shared };
  assert.equal(
    scenarioArtifactRoot(firstProject, "fusion", {}),
    path.join(firstProject, ".test-artifacts/scenarios"),
  );
  assert.equal(
    scenarioArtifactRoot(firstProject, "simulator", env),
    path.join(firstProject, ".test-artifacts/scenarios"),
  );
  assert.notEqual(
    scenarioArtifactRoot(firstProject, "simulator", env),
    scenarioArtifactRoot(secondProject, "simulator", env),
  );
});

test("live artifact root rejects unsafe or source-coupled selections", (t) => {
  const { root, firstProject, shared } = directories(t),
    selected = (value: string) => ({ [liveScenarioArtifactRootEnv]: value });
  assert.throws(
    () => scenarioArtifactRoot(firstProject, "fusion", selected("relative")),
    /must be an absolute directory/u,
  );
  assert.throws(
    () => scenarioArtifactRoot(firstProject, "fusion", selected(firstProject)),
    /separate from the source checkout/u,
  );
  assert.throws(
    () => scenarioArtifactRoot(firstProject, "fusion", selected(root)),
    /separate from the source checkout/u,
  );
  assert.throws(() =>
    scenarioArtifactRoot(
      firstProject,
      "fusion",
      selected(path.join(root, "missing")),
    ),
  );

  if (process.platform !== "win32") {
    fs.chmodSync(shared, 0o755);
    assert.throws(
      () => scenarioArtifactRoot(firstProject, "fusion", selected(shared)),
      /must be private to the current user/u,
    );
    fs.chmodSync(shared, 0o700);

    const link = path.join(root, "campaign-link");
    fs.symlinkSync(shared, link, "dir");
    assert.throws(
      () => scenarioArtifactRoot(firstProject, "fusion", selected(link)),
      /must name a regular directory/u,
    );
  }
});
