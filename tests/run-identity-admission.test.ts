import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { PreparedPythonArtifact } from "../packages/core/src/domain/python-artifact";
import type { createPythonChecker as CheckerFactory } from "../packages/node-adapters/src/python/checker";
import * as programs from "./scenarios/programs";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { prepareRunScript } = load("./src/run") as {
  prepareRunScript(
    file: string,
    args: undefined,
    hasArgs: false,
    doc: string,
    identity: { docId: string },
  ): PreparedPythonArtifact;
};
const { createPythonChecker } = load("./src/python") as {
  createPythonChecker: typeof CheckerFactory;
};

test("owned raw-run scripts pass real admission using the canonical typed identity guard", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(tmpdir(), "run-identity-admission-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = { name: "Owned document", creationId: "owned-creation" };
  const checker = createPythonChecker({
    typingRoot: path.join(root, "runtime/python/typing"),
    definitionsRoot: path.join(root, "dist/runtime/python/typing"),
    temporaryRoot: directory,
  });
  for (const [phase, source] of Object.entries({
    export: programs.exportFile(target, path.join(directory, "fixture.f3d")),
    write: programs.parameter(target, 12),
    read: programs.parameter(target),
    inspect: programs.inspect(target),
    cleanup: programs.close(target),
  })) {
    const file = path.join(directory, `${phase}.py`);
    fs.writeFileSync(file, source);
    const artifact = prepareRunScript(file, undefined, false, target.name, {
      docId: target.creationId,
    });
    const identity = artifact.units.find((unit) => unit.id === "identity");
    assert.equal(
      identity?.filename,
      "runtime/python/fmcad/adapters/fusion/identity.py",
    );
    const report = await checker.check({
      artifact,
      context: { kind: "raw", entrypoint: "run" },
    });
    assert.equal(
      report.status,
      "passed",
      `${phase}: ${JSON.stringify(report)}`,
    );
  }
});
