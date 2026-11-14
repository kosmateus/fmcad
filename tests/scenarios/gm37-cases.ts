import assert from "node:assert/strict";
import { cadCommand } from "./cad-programs";
import type { ScenarioSession } from "./runner";
import { gmCommands } from "./gm-command-contract";
import { at, list, text } from "../integration/offline-cli";
export const g37_1 = {
  id: "G37-01",
  title:
    "G37-01: check.set evaluates scalar/vector/count/boolean predicates distinctly",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "check",
      "set",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        checks: [
          {
            id: "od",
            predicate: {
              kind: "scalar",
              actual: { value: 25.0 },
              expected: { min: 24.0, max: 26.0 },
            },
          },
          {
            id: "axis",
            predicate: {
              kind: "vector",
              actual: { components: [1, 2, 3] },
              expected: { components: [1, 2, 3], tolerance: 0.1 },
            },
          },
          {
            id: "holes",
            predicate: {
              kind: "count",
              actual: { count: 5 },
              expected: { min: 4, max: 6 },
            },
          },
          {
            id: "sealed",
            predicate: {
              kind: "boolean",
              actual: { value: true },
              expected: true,
            },
          },
        ],
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(
      at(out, "result", "itemCount"),
      4,
      JSON.stringify(at(out, "result")),
    );
    assert.equal(
      at(out, "result", "passCount"),
      4,
      JSON.stringify(at(out, "result")),
    );
    assert.equal(
      at(out, "result", "checkPassed"),
      true,
      JSON.stringify(at(out, "result")),
    );
    assert.equal(
      at(out, "result", "executionSucceeded"),
      true,
      JSON.stringify(at(out, "result")),
    );
    assert.equal(
      at(out, "result", "executionSucceededIsNotCheckPassed"),
      true,
      JSON.stringify(at(out, "result")),
    );
  },
};
export const g37_2 = {
  id: "G37-02",
  title:
    "G37-02: check.set scalar predicate reuses declared-value comparison with tolerance",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "check",
      "set",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        checks: [
          {
            id: "within",
            predicate: {
              kind: "scalar",
              actual: { value: 25.0 },
              expected: { equals: 25.0 },
              tolerance: 0.5,
            },
          },
          {
            id: "over",
            predicate: {
              kind: "scalar",
              actual: { value: 25.0 },
              expected: { min: 24.0 },
            },
          },
        ],
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    const within = list(at(out, "result", "items")).find(
      (item) => at(item, "id") === "within",
    );
    assert.equal(
      at(within, "method"),
      "declared-value comparison",
      JSON.stringify(at(out, "result")),
    );
    assert.equal(at(within, "passed"), true, JSON.stringify(at(out, "result")));
  },
};
export const g37_3 = {
  id: "G37-03",
  title:
    "G37-03: check.set continues after an ordinary fail and skips dependents of an error",
  async run(session: ScenarioSession) {
    const { cli } = gmCommands(session);
    const result = await cli([
      "check",
      "set",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        checks: [
          {
            id: "tight",
            predicate: {
              kind: "scalar",
              actual: { value: 25.0 },
              expected: { min: 30.0 },
            },
          },
          {
            id: "ok",
            predicate: {
              kind: "scalar",
              actual: { value: 5.0 },
              expected: { min: 0.0, max: 10.0 },
            },
          },
          { id: "broken", predicate: { kind: "bogus", actual: { value: 1 } } },
          {
            id: "dep",
            predicate: {
              kind: "scalar",
              actual: { value: 1 },
              expected: { min: 0 },
            },
            dependsOn: ["broken"],
          },
        ],
      }),
    ]);
    assert.ok(
      at(result, "out"),
      "expected a JSON envelope: " + at(result, "err"),
    );
    assert.equal(
      at(result, "out", "status"),
      "blocked",
      JSON.stringify(at(result, "out")),
    );
    assert.equal(
      at(result, "out", "success"),
      false,
      JSON.stringify(at(result, "out")),
    );
    assert.equal(
      at(result, "out", "result", "failCount"),
      1,
      JSON.stringify(at(result, "out", "result")),
    );
    assert.equal(
      at(result, "out", "result", "passCount"),
      1,
      JSON.stringify(at(result, "out", "result")),
    );
    assert.equal(
      at(result, "out", "result", "errorCount"),
      1,
      JSON.stringify(at(result, "out", "result")),
    );
    assert.equal(
      at(result, "out", "result", "skippedCount"),
      1,
      JSON.stringify(at(result, "out", "result")),
    );
    const dep = list(at(result, "out", "result", "items")).find(
      (item) => at(item, "id") === "dep",
    );
    assert.equal(
      at(dep, "outcome"),
      "notEvaluated",
      JSON.stringify(at(result, "out", "result")),
    );
    assert.match(
      text(at(dep, "reason")),
      /dependency/,
      JSON.stringify(at(result, "out", "result")),
    );
  },
};
export const g37_4 = {
  id: "G37-04",
  title: "G37-04: missing data and stale evidence are distinct from fail",
  async run(session: ScenarioSession) {
    const { cad } = gmCommands(session);
    const { json: out } = await cad([
      "check",
      "set",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        checks: [
          { id: "undeclared", predicate: { kind: "scalar" } },
          {
            id: "stale",
            predicate: {
              kind: "scalar",
              actual: { value: 25.0 },
              expected: { min: 24.0, max: 26.0 },
            },
            source: { path: "drawing", status: "ESTIMATED" },
          },
        ],
      }),
    ]);
    // Accepted pre-refactor policy refuses unknown at the public boundary.
    assert.equal(at(out, "success"), false, JSON.stringify(out));
    assert.equal(at(out, "result", "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "unknown", JSON.stringify(out));
    assert.equal(
      at(out, "result", "missingCount"),
      1,
      JSON.stringify(at(out, "result")),
    );
    assert.equal(
      at(out, "result", "staleCount"),
      1,
      JSON.stringify(at(out, "result")),
    );
    const undeclared = list(at(out, "result", "items")).find(
      (item) => at(item, "id") === "undeclared",
    );
    const stale = list(at(out, "result", "items")).find(
      (item) => at(item, "id") === "stale",
    );
    assert.equal(
      at(undeclared, "outcome"),
      "missing",
      JSON.stringify(at(out, "result")),
    );
    assert.equal(
      at(stale, "outcome"),
      "stale",
      JSON.stringify(at(out, "result")),
    );
  },
};
export const g37_5 = {
  id: "G37-05",
  title:
    "G37-05: evidence.package reports manifest, completeness and stale items",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "evidence",
      "package",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        evidence: [
          {
            id: "housing-drawing",
            kind: "drawing",
            path: "drawings/housing.svg",
            revision: "B",
            source: { path: "drawings", revision: "B", status: "CONFIRMED" },
          },
          { id: "housing-model", kind: "model", path: "models/housing.f3d" },
          {
            id: "proto-film",
            kind: "film",
            path: "evidence/proto.mp4",
            gate: "G7",
            supplierApproval: { supplier: "molder", approved: true },
          },
          { id: "proto-photo", kind: "image", path: "evidence/proto.png" },
        ],
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(
      at(out, "result", "complete"),
      true,
      JSON.stringify(at(out, "result")),
    );
    assert.equal(
      at(out, "result", "itemCount"),
      4,
      JSON.stringify(at(out, "result")),
    );
    assert.deepEqual(
      at(out, "result", "missing"),
      [],
      JSON.stringify(at(out, "result")),
    );
    assert.equal(
      list(at(out, "result", "manifest")).length,
      4,
      JSON.stringify(at(out, "result")),
    );
  },
};
export const g37_6 = {
  id: "G37-06",
  title:
    "G37-06: evidence.check marks missing required evidence unresolved, not failed",
  async run(session: ScenarioSession) {
    const { cad } = gmCommands(session);
    const { json: out } = await cad([
      "evidence",
      "check",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        evidence: [
          { id: "housing-model", kind: "model", path: "models/housing.f3d" },
        ],
        required: ["film"],
      }),
    ]);
    // Accepted pre-refactor policy refuses unknown at the public boundary.
    assert.equal(at(out, "success"), false, JSON.stringify(out));
    assert.equal(at(out, "result", "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "unknown", JSON.stringify(out));
    assert.equal(
      at(out, "result", "complete"),
      false,
      JSON.stringify(at(out, "result")),
    );
    assert.deepEqual(
      at(out, "result", "missing"),
      [{ kind: "film" }],
      JSON.stringify(at(out, "result")),
    );
  },
};
export const g37_7 = {
  id: "G37-07",
  title:
    "G37-07: deliver composes checks and evidence into an acceptance manifest",
  async run(session: ScenarioSession) {
    const { fmcad } = gmCommands(session);
    const out = await fmcad([
      "deliver",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        checks: [
          {
            id: "od",
            predicate: {
              kind: "scalar",
              actual: { value: 25.0 },
              expected: { min: 24.0, max: 26.0 },
            },
          },
        ],
        evidence: [
          {
            id: "proto-film",
            kind: "film",
            path: "evidence/proto.mp4",
            gate: "G7",
            supplierApproval: { supplier: "molder", approved: true },
          },
        ],
        gate: "G7",
      }),
    ]);
    assert.equal(at(out, "success"), true, JSON.stringify(out));
    assert.equal(at(out, "status"), "pass", JSON.stringify(out));
    assert.equal(
      at(out, "result", "accepted"),
      true,
      JSON.stringify(at(out, "result")),
    );
    assert.equal(
      at(out, "result", "gate"),
      "G7",
      JSON.stringify(at(out, "result")),
    );
    assert.equal(
      list(at(out, "result", "manifest")).length,
      1,
      JSON.stringify(at(out, "result")),
    );
  },
};
export const g37_9 = {
  id: "G37-09",
  title:
    "G37-09: a stale supplier approval blocks delivery (G7/G8 evidence required)",
  async run(session: ScenarioSession) {
    const { cli } = gmCommands(session);
    const result = await cli([
      "deliver",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        checks: [
          {
            id: "od",
            predicate: {
              kind: "scalar",
              actual: { value: 25.0 },
              expected: { min: 24.0, max: 26.0 },
            },
          },
        ],
        evidence: [
          {
            id: "proto-film",
            kind: "film",
            path: "evidence/proto.mp4",
            gate: "G7",
            supplierApproval: { supplier: "molder", approved: false },
          },
        ],
        gate: "G7",
      }),
    ]);
    assert.ok(
      at(result, "out"),
      "expected a JSON envelope: " + at(result, "err"),
    );
    assert.equal(
      at(result, "out", "status"),
      "unknown",
      JSON.stringify(at(result, "out")),
    );
    assert.equal(
      at(result, "out", "result", "accepted"),
      false,
      JSON.stringify(at(result, "out")),
    );
  },
};
export const g37_10 = {
  id: "G37-10",
  title:
    "G37-10: deliver does not accept a document marked valid but unverified",
  async run(session: ScenarioSession) {
    const { cli } = gmCommands(session);
    // A source marked ESTIMATED (even with a passing predicate) is stale, so a
    // deliver over it is not accepted: model acceptance is never implied.
    const result = await cli([
      "deliver",
      "--doc",
      session.document.name,
      "--data",
      JSON.stringify({
        schemaVersion: 1,
        checks: [
          {
            id: "od",
            predicate: {
              kind: "scalar",
              actual: { value: 25.0 },
              expected: { min: 24.0, max: 26.0 },
            },
            source: { path: "CHECKED_DOCUMENT", status: "ESTIMATED" },
          },
        ],
        gate: "G8",
      }),
    ]);
    assert.ok(
      at(result, "out"),
      "expected a JSON envelope: " + at(result, "err"),
    );
    assert.equal(
      at(result, "out", "result", "accepted"),
      false,
      JSON.stringify(at(result, "out")),
    );
  },
};
export const g37_8 = {
  id: "G37-08",
  title: "G37-08 empty required checklist is refused",
  async run(session: ScenarioSession) {
    const result = await session.execute(
      "empty-required-checklist",
      cadCommand(session.document, "deliver", {
        schemaVersion: 1,
        checks: [],
      }),
      session.document,
      "cad-v1",
    );
    assert.match(
      String(result["error"]),
      /checks.*nonempty|checks.*non-empty|checklist.*empty/u,
    );
    assert.equal(result["result"], null);
  },
};
export const gm37Cases = [
  g37_1,
  g37_2,
  g37_3,
  g37_4,
  g37_5,
  g37_6,
  g37_7,
  g37_8,
  g37_9,
  g37_10,
];
