import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { ScenarioSession } from "./runner";
import { record, text } from "./contracts";
import { emit, program } from "./programs";
import {
  assertReceiptBoundDocumentInventory,
  assertOwnedUnsavedDocument,
  discoverOwnedUnsavedFixtureProofs,
} from "./fixture-provenance";

const root = path.resolve(__dirname, "../../..");
const { catalog, validateCad } = createRequire(path.join(root, "package.json"))(
  "./src/cad",
) as typeof import("../../src/composition/cad-execution");
export const values = (value: unknown): unknown[] => {
  assert.ok(Array.isArray(value));
  return value;
};

/** Preserve the retained fixture's conservative nested uncertainty stop. */
export function nativeResultUncertain(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (!Array.isArray(value)) {
    const row = record(value);
    if (
      row["status"] === "unknown" ||
      row["executionOutcome"] === "unknown" ||
      row["completed"] === false ||
      ["started", "running", "pending"].includes(String(row["status"]))
    )
      return true;
  }
  return Object.values(value).some(nativeResultUncertain);
}

interface Invocation {
  operation: string;
  status: string;
  result: Record<string, unknown>;
  assertions?: string[];
}
interface Readback {
  operation: string;
  label: string;
  actual: unknown;
  expected: unknown;
  tolerance: number;
  status: "pass" | "fail";
}

/** Retained native readback helpers over the one existing owner/receipt lifecycle. */
export async function nativeModelingHarness(
  session: ScenarioSession,
  retainedSource: string,
  setupOperations: readonly string[],
  targetOperations: readonly string[],
  options: { honorResultStatus?: boolean } = {},
) {
  const identity = session.document;
  assert.equal(identity.file, undefined, "Fixture unexpectedly saved.");
  const indexPath = path.join(session.directory, "..", "index.json");
  const stat = fs.lstatSync(indexPath);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink(),
    "Expected the owned coordinator inventory",
  );
  const coordinator = record(
    JSON.parse(fs.readFileSync(indexPath, "utf8")) as unknown,
  );
  assert.equal(coordinator["runId"], session.report.owner.runId);
  assert.ok(
    values(coordinator["scenarioIds"]).includes(
      session.report.owner.scenarioId,
    ),
  );
  const baseline = record(coordinator["before"]);
  assert.ok(
    !values(baseline["documents"])
      .map(record)
      .some((doc) => doc["name"] === identity.name),
    "Fixture name already exists.",
  );
  const report = {
    retainedSource,
    owner: session.report.owner,
    document: identity,
    backendIdentity: session.backend.identity,
    fusionVersion: null as string | null,
    scope:
      "Owned synthetic unsaved document; no user-document edit or cloud write.",
    results: [] as Invocation[],
    assertions: [] as Readback[],
  };
  const persist = () => {
    fs.writeFileSync(
      path.join(session.directory, "native-readback.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(session.directory, "operation-coverage.json"),
      JSON.stringify(
        [...new Set([...setupOperations, ...targetOperations])].map(
          (operation) => ({
            operation,
            canonical: true,
            test: retainedSource,
            status: report.results.some(
              (row) => row.operation === operation && row.status === "pass",
            )
              ? "pass"
              : "not-passed",
          }),
        ),
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  };
  let sequence = 0;
  const state = async () => {
    const result = await session.observe(
      "observe-native-modeling-state-" + sequence++,
      program(`import adsk.core, json, tempfile, os
app = adsk.core.Application.get()
owned = [d for d in app.documents if d.creationId == ${JSON.stringify(identity.creationId)}]
assert len(owned) == 1, 'Owned fixture is unavailable or ambiguous'
docs = [dict(name=d.name, creationId=d.creationId, fileId=d.dataFile.id if d.dataFile else None, saved=d.isSaved, modified=d.isModified, active=d == app.activeDocument) for d in app.documents]
${emit("dict(creationId=owned[0].creationId, version=app.version, documents=docs, tempDir=tempfile.gettempdir(), tempExists=os.path.isdir(tempfile.gettempdir()))")}`),
    );
    if (nativeResultUncertain(result))
      session.deferCleanup(
        "Native fixture probe is unknown/pending; do not replay.",
      );
    return result;
  };
  const ownedFixtures = () => {
    const fixtures = new Map(
      discoverOwnedUnsavedFixtureProofs(
        path.dirname(path.dirname(session.directory)),
        session.backend,
      ),
    );
    const own = fixtures.get(identity.creationId);
    if (own) {
      assert.equal(own.state, "open");
      assert.deepEqual(own.document, identity);
    }
    fixtures.set(identity.creationId, { document: identity, state: "open" });
    return fixtures;
  };
  // State snapshots are read-only; operation fences remain strict in-turn.
  const unchangedOthers = (current: Record<string, unknown>) =>
    assertReceiptBoundDocumentInventory(
      baseline["documents"],
      current["documents"],
      ownedFixtures(),
      "An original document changed during feature coverage.",
      true,
    );
  const guard = async () => {
    try {
      assert.ok(identity.creationId, "No verified owned creationId.");
      const current = await state();
      unchangedOthers(current);
      const matches = values(current["documents"])
        .map(record)
        .filter((doc) => doc["name"] === identity.name);
      assert.equal(matches.length, 1, "Fixture name is ambiguous or missing.");
      const match = record(matches[0]);
      assert.equal(
        match["creationId"],
        identity.creationId,
        "Fixture name now refers to another document.",
      );
      assert.equal(
        match["fileId"],
        null,
        "Fixture unexpectedly has a cloud file ID.",
      );
      assert.equal(match["saved"], false, "Fixture unexpectedly saved.");
      // A peer may activate its own document between SDK turns. Mutating CAD
      // selects and verifies this exact target inside its same-turn fence.
      return current;
    } catch (error) {
      if (session.uncertain) throw error;
      session.deferCleanup(
        "Owned native fixture guard failed; leave the document for inspection: " +
          String(error),
      );
    }
  };
  const cad = async (
    operation: string,
    data: Record<string, unknown>,
    scope = "root",
    mutating = !catalog[operation]?.readOnly,
  ) => {
    assert.ok(catalog[operation], "Unknown canonical operation: " + operation);
    validateCad(operation, data);
    if (mutating) await guard();
    const phase = "cad-native-modeling-" + sequence++ + "-" + operation;
    const output = mutating
      ? await session.cadFenced(phase, operation, data, { component: scope })
      : await session.cad(phase, operation, data, { component: scope });
    if (nativeResultUncertain(output))
      session.deferCleanup(
        operation + " returned unknown/pending; do not replay.",
      );
    assert.equal(
      session.report.requests.at(-1)?.result?.state,
      "succeeded",
      "Native command did not complete successfully.",
    );
    assert.equal(output["success"], true, JSON.stringify(output));
    assert.equal(output["operation"], operation);
    assert.equal(output["document"], identity.name);
    const result = record(output["result"]);
    assert.ok(
      Object.keys(result).length,
      operation + " returned no native result object.",
    );
    report.results.push({
      operation,
      status:
        options.honorResultStatus &&
        result["status"] &&
        result["status"] !== "pass"
          ? text(result["status"])
          : "invoked",
      result,
    });
    persist();
    return result;
  };
  const check = (
    operation: string,
    label: string,
    actual: unknown,
    expected: unknown,
    tolerance = 0,
  ) => {
    const passed = tolerance
      ? typeof actual === "number" &&
        Number.isFinite(actual) &&
        typeof expected === "number" &&
        Math.abs(actual - expected) <= tolerance
      : actual === expected;
    const row: Readback = {
      operation,
      label,
      actual,
      expected,
      tolerance,
      status: passed ? "pass" : "fail",
    };
    report.assertions.push(row);
    const result = report.results.findLast(
      (item) => item.operation === operation && item.status === "invoked",
    );
    if (result) result.assertions = [...(result.assertions || []), label];
    persist();
    assert.ok(passed, JSON.stringify(row));
  };
  const validated = (operation: string, allInvocations = false) => {
    const results = report.results.filter(
      (item) => item.operation === operation && item.status === "invoked",
    );
    assert.ok(results.length, operation + " has no native result to validate.");
    for (const result of allInvocations ? results : [results.at(-1)!])
      result.status = "pass";
    persist();
  };
  persist();
  const afterCreate = await guard();
  report.fusionVersion = text(afterCreate["version"]);
  persist();
  assert.ok(
    !values(baseline["documents"])
      .map(record)
      .some((doc) => doc["creationId"] === identity.creationId),
    "Owned fixture identity already exists in the coordinator baseline.",
  );
  assertOwnedUnsavedDocument(afterCreate["documents"], identity);
  return {
    identity,
    baseline,
    report,
    persist,
    state,
    guard,
    cad,
    check,
    validated,
  };
}
