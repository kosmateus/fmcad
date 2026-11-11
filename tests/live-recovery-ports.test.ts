import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { knownSettlement, ownedCleanupSource } from "./live-recovery-ports";
import type { Result } from "./live-recovery-ports";

test("cleanup evidence rejects missing, nonterminal and unsettled work", () => {
  const evidence = (state: string, sdkSettled: boolean): Result => ({
    job: { id: "original", requestId: "stable", clientId: "owner", state },
    stdout: "",
    execution: { sdkSettled },
  });
  assert.equal(knownSettlement([]), false);
  assert.equal(knownSettlement([undefined]), false);
  for (const state of ["preparing", "running", "needs_reconciliation"])
    assert.equal(knownSettlement([evidence(state, true)]), false);
  assert.equal(knownSettlement([evidence("succeeded", false)]), false);
  assert.equal(
    knownSettlement([evidence("failed", true), evidence("succeeded", true)]),
    true,
  );
});

test("owned cleanup Python is exact-ID/name/unsaved guarded and handles null restore without Python null", () => {
  for (const restore of [null, 'previous "quoted" document']) {
    const code = ownedCleanupSource(
      { name: "Owned", creationId: "own-new-id" },
      restore,
      "FMCAD_RESULT ",
    );
    const compiled = spawnSync(
      "python3",
      ["-c", "import ast,sys; ast.parse(sys.stdin.read()); print('COMPILED')"],
      { input: code, encoding: "utf8" },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    assert.match(code, /creationId=="own-new-id"/);
    assert.match(code, /d\.name=="Owned" and not d\.isSaved/);
    assert.match(code, /assert d\.close\(False\)/);
    assert.doesNotMatch(code, /==null|\.deleteMe\(|\.save\(/);
  }
});
