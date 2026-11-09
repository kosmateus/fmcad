import assert from "node:assert/strict";
import { number, record, text } from "./contracts";
import type { DeclarationCase } from "./retained-declaration-cases";
const list = (v: unknown): unknown[] => {
  assert.ok(Array.isArray(v));
  return v;
};
const at = (v: unknown, ...keys: (string | number)[]): unknown => {
  for (const key of keys)
    v = typeof key === "number" ? list(v)[key] : record(v)[key];
  return v;
};
const includes = (v: unknown, item: unknown): boolean =>
  typeof v === "string" ? v.includes(text(item)) : list(v).includes(item);
const near = (actual: unknown, expected: number, tol = 1e-6, msg = "") =>
  assert.ok(
    Math.abs(number(actual) - expected) <= tol,
    `${msg} expected ${expected}, got ${String(actual)}`,
  );

export const cases: readonly DeclarationCase[] = [
  {
    id: "g15-02",
    async run(cad) {
      const out = await cad("seal.gland", {
        schemaVersion: 1,
        frame: "component",
        type: "radial",
        oRing: { id: "10 mm", cs: "2 mm" },
        squeeze: 0.15,
        hardStop: { clearance: "0.05 mm" },
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      const body = out;
      near(
        at(at(at(body, "gland"), "depth"), "value"),
        1.7,
        1e-6,
        "gland depth",
      );
      near(at(at(body, "squeeze"), "nominal"), 0.15, 1e-6, "squeeze nominal");
      near(at(at(body, "fill"), "nominal"), 0.75, 1e-4, "fill nominal");
      assert.ok(at(body, "hardStop"), JSON.stringify(out));
      near(
        at(at(at(body, "hardStop"), "clearance"), "value"),
        0.05,
        1e-6,
        "hardStop clearance",
      );
      assert.match(
        text(at(at(body, "hardStop"), "role")),
        /does not set squeeze/,
      );
    },
  },
  {
    id: "g15-03",
    async run(cad) {
      const out = await cad("seal.profile", {
        schemaVersion: 1,
        frame: "component",
        crossSection: {
          shape: "custom",
          points: [
            ["0 mm", "0 mm"],
            ["2 mm", "0 mm"],
            ["2 mm", "1.5 mm"],
            ["0 mm", "1.5 mm"],
            ["0 mm", "0 mm"],
          ],
        },
        layout: "gasket",
        path: { closed: true, length: "80 mm" },
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      const body = out;
      assert.equal(
        at(at(body, "crossSection"), "isPlainORing"),
        false,
        JSON.stringify(out),
      );
      assert.equal(
        at(at(at(body, "crossSection"), "continuity"), "closed"),
        true,
        JSON.stringify(out),
      );
      assert.equal(
        at(at(body, "envelope"), "type"),
        "sweep",
        JSON.stringify(out),
      );
    },
  },
  {
    id: "g15-04",
    async run(cad) {
      const out = await cad("seal.evaluate", {
        schemaVersion: 1,
        frame: "component",
        oRing: { id: "10 mm", cs: "2 mm" },
        gland: { depth: "1.6 mm", width: "2.4 mm" },
        type: "radial",
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      const body = out;
      near(at(body, "squeeze"), 0.2, 1e-6, "squeeze");
      const gap = list(at(body, "checks")).find(
        (c) => at(c, "check") === "extrusion-gap",
      );
      assert.ok(gap, JSON.stringify(out));
      assert.equal(at(gap, "status"), "notEvaluated", JSON.stringify(out));
    },
  },
  {
    id: "g15-05",
    async run(cad) {
      const out = await cad("seal.gland", {
        schemaVersion: 1,
        frame: "component",
        type: "radial",
        oRing: { id: "10 mm", cs: "2 mm" },
        gland: { depth: "1.7 mm" },
        swell: 0.03,
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      const body = out;
      near(
        at(at(at(body, "oRing"), "cs"), "value"),
        2.0,
        1e-6,
        "undeformed cs",
      );
      near(
        at(at(body, "installedCs"), "value"),
        number(2.0) * number(Math.sqrt(number(1.03))),
        1e-6,
        "installed cs",
      );
      assert.notEqual(
        at(at(body, "installedCs"), "value"),
        at(at(at(body, "oRing"), "cs"), "value"),
      );
      assert.match(
        text(at(body, "installedEnvelope")),
        /no material\/sealing solution/,
      );
    },
  },
  {
    id: "g15-06",
    async run(cad) {
      const out = await cad("dock.sequence-check", {
        schemaVersion: 1,
        frame: "component",
        connect: [
          { event: "lead-in", at: "0 mm" },
          { event: "locator-engage", at: "2 mm" },
          { event: "seal-contact", at: "4 mm" },
          { event: "valve-open", at: "4.6 mm" },
          { event: "both-valve-open", at: "5 mm" },
        ],
        disconnect: [
          { event: "valve-close", at: "5 mm" },
          { event: "valve-close", at: "4.6 mm" },
          { event: "seal-contact", at: "4 mm" },
          { event: "locator-engage", at: "2 mm" },
          { event: "lead-in", at: "0 mm" },
        ],
        minimumSealBeforeOpen: "0.5 mm",
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      const body = out;
      assert.equal(
        list(at(body, "connectOrder")).length,
        5,
        JSON.stringify(out),
      );
      assert.equal(
        list(at(body, "disconnectOrder")).length,
        5,
        JSON.stringify(out),
      );
      const bothOpen = list(at(body, "checks")).find(
        (c) => at(c, "check") === "both-valve-open",
      );
      assert.ok(bothOpen, JSON.stringify(out));
      assert.equal(at(bothOpen, "status"), "pass", JSON.stringify(out));
    },
  },
  {
    id: "g15-07",
    async run(cad) {
      const out = await cad("seal.profile", {
        schemaVersion: 1,
        frame: "component",
        crossSection: { shape: "circle", radius: "1 mm" },
        layout: "face",
        axis: "Z",
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      const body = out;
      assert.equal(
        at(at(body, "crossSection"), "isPlainORing"),
        true,
        JSON.stringify(out),
      );
      assert.equal(
        at(at(at(body, "crossSection"), "continuity"), "closed"),
        true,
        JSON.stringify(out),
      );
      assert.match(
        text(at(at(at(body, "crossSection"), "continuity"), "continuity")),
        /G0/,
      );
      assert.equal(
        at(at(body, "envelope"), "type"),
        "revolution",
        JSON.stringify(out),
      );
    },
  },
  {
    id: "g15-08",
    async run(cad) {
      const out = await cad("dock.sequence-check", {
        schemaVersion: 1,
        frame: "component",
        connect: [
          { event: "lead-in", at: "0 mm" },
          { event: "locator-engage", at: "2 mm" },
          { event: "seal-contact", at: "4 mm" },
          { event: "valve-open", at: "4.6 mm" },
          { event: "both-valve-open", at: "5 mm" },
        ],
        axialTolerance: "0.1 mm",
        minimumSealBeforeOpen: "0.5 mm",
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      const body = out;
      near(
        at(at(body, "sealBeforeOpenMargin"), "value"),
        0.6,
        1e-6,
        "sealBeforeOpenMargin",
      );
      near(
        at(at(body, "worstCaseMargin"), "value"),
        0.5,
        1e-6,
        "worstCaseMargin",
      );
      assert.ok(
        number(at(at(body, "worstCaseMargin"), "value")) >=
          number(number(0.5) - number(1e-6)),
        JSON.stringify(out),
      );
    },
  },
];
