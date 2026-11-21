import { createRequire } from "node:module";
import { object, array, field, string } from "./modeling-unit-test-support.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fixtureDirectory = path.join(process.cwd(), "tests");
const load = createRequire(
  path.join(fixtureDirectory, "preview-dispatch.test.ts"),
);
const { main } = load(
  "../src/cli",
) as import("./modeling-unit-test-support.js").ModelingFixtureCli;
const { validateBatch } = load(
  "../src/batch",
) as typeof import("../src/composition/batch.js");
const { catalog } = load(
  "../src/cad",
) as typeof import("../src/composition/cad-execution.js");

async function preview(argv: string[]) {
  let stdout = "",
    stderr = "";
  const exit = await main(argv, {
    loadConfig: () => assert.fail("Preview must not load configuration"),
    createBackend: () => assert.fail("Preview must not create a backend"),
    stdout: {
      write: (value) => {
        stdout += value;
      },
    },
    stderr: {
      write: (value) => {
        stderr += value;
      },
    },
    setExitCode: () => {},
  });
  assert.equal(stderr, "");
  return { exit, result: object(JSON.parse(stdout)) };
}

test("definition and batch --preview expand and validate without backend or report writes", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-preview-dispatch-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const data = {
    runId: "preview-dispatch",
    reportPath: path.join(directory, "must-not-exist"),
    parameters: { entityKind: "body" },
    operations: [
      {
        id: "bodies",
        operation: "entity.list",
        data: { kind: { $param: "entityKind" } },
      },
    ],
  };
  const expected = validateBatch(data, catalog);
  assert.equal(expected.success, true);
  for (const command of [
    ["definition", "instantiate"],
    ["batch", "run"],
    ["batch", "preview"],
    ["batch", "validate"],
  ]) {
    const { exit, result } = await preview([
      ...command,
      "--doc",
      "Model",
      "--data",
      JSON.stringify(data),
      "--preview",
    ]);
    assert.equal(exit, 0);
    assert.equal(result["mode"], "preview");
    assert.equal(result["mutated"], false);
    assert.equal(
      result["mutation"],
      false,
      "retain the existing flag-preview compatibility field",
    );
    assert.deepEqual(result["operations"], expected.operations);
    assert.equal(field(result, "operations", 0, "data", "kind"), "body");
  }
  assert.deepEqual(await fs.readdir(directory), []);
});

test("generic preview cannot bypass invalid nested batch-operation rejection", async () => {
  const data = {
    runId: "invalid-preview",
    operations: [{ id: "bad", operation: "not.registered", data: {} }],
  };
  for (const command of [
    ["definition", "instantiate"],
    ["batch", "run"],
  ]) {
    const { exit, result } = await preview([
      ...command,
      "--doc",
      "Model",
      "--data",
      JSON.stringify(data),
      "--preview",
    ]);
    assert.equal(exit, 1);
    assert.equal(result["success"], false);
    assert.equal(result["mutated"], false);
    assert.match(
      array(result["errors"]).map(string).join("\n"),
      /Unknown or non-CAD operation/,
    );
  }
});

test("ordinary CAD and historical report preview retain outer-only no-read behavior", async () => {
  for (const argv of [
    [
      "component",
      "create",
      "--doc",
      "Model",
      "--data",
      '{"name":"Offline"}',
      "--preview",
    ],
    [
      "batch",
      "summary",
      "--report-path",
      "/missing-preview-report",
      "--preview",
      "--json",
    ],
  ]) {
    const { exit, result } = await preview(argv);
    assert.equal(exit, 0);
    assert.equal(result["state"], "input-validated-only");
    assert.equal(result["mutation"], false);
    assert.equal(result["operations"], undefined);
  }
});
