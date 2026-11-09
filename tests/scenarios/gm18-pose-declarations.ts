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
const servicePose = (name: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  frame: "component",
  name,
  fillState: "EMPTY",
  springState: "COCKED",
  service: { disconnections: ["tank-dock"] },
  ...extra,
});
export const cases: readonly DeclarationCase[] = [
  {
    id: "g18-01",
    async run(cad) {
      const saved = await cad("pose.save", servicePose("Service"));
      assert.equal(at(saved, "success"), true, JSON.stringify(saved));
      assert.equal(at(saved, "status"), "pass", JSON.stringify(saved));
      assert.equal(at(saved, "name"), "Service", JSON.stringify(saved));
      assert.equal(at(saved, "revision"), 1, JSON.stringify(saved));
      assert.equal(
        at(at(saved, "manifest"), "schema"),
        "fmcad.pose.manifest.v1",
        JSON.stringify(saved),
      );
      assert.equal(
        at(at(saved, "manifest"), "fillState"),
        "EMPTY",
        JSON.stringify(saved),
      );
      const listed = await cad("pose.list", {
        schemaVersion: 1,
        frame: "component",
      });
      assert.equal(at(listed, "status"), "pass", JSON.stringify(listed));
      assert.equal(at(listed, "count"), 1, JSON.stringify(listed));
      assert.equal(
        at(at(at(listed, "poses"), 0), "name"),
        "Service",
        JSON.stringify(listed),
      );
      const deleted = await cad("pose.delete", {
        schemaVersion: 1,
        frame: "component",
        name: "Service",
        confirm: true,
      });
      assert.equal(at(deleted, "status"), "pass", JSON.stringify(deleted));
      assert.equal(at(deleted, "deleted"), true, JSON.stringify(deleted));
      const after = await cad("pose.list", {
        schemaVersion: 1,
        frame: "component",
      });
      assert.equal(at(after, "count"), 0, JSON.stringify(after));
    },
  },
  {
    id: "g18-02",
    async run(cad) {
      await cad("pose.save", servicePose("Service"));
      const out = await cad("pose.apply", {
        schemaVersion: 1,
        frame: "component",
        name: "Service",
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.equal(at(out, "leftApplied"), true, JSON.stringify(out));
      assert.deepEqual(at(out, "unapplied"), [], JSON.stringify(out));
    },
  },
  {
    id: "g18-03",
    async run(cad) {
      await cad("pose.save", servicePose("Service"));
      const out = await cad("pose.evaluate", {
        schemaVersion: 1,
        frame: "component",
        name: "Service",
      });
      assert.equal(at(out, "success"), true, JSON.stringify(out));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.equal(at(out, "restored"), true, JSON.stringify(out));
      assert.deepEqual(at(out, "restoreErrors"), [], JSON.stringify(out));
    },
  },
  {
    id: "g18-04",
    async run(cad) {
      const payload = {
        schemaVersion: 1,
        frame: "component",
        name: "Full",
        joints: [{ joint: { token: "joint-1" }, rotation: "30 deg" }],
        parameters: [{ name: "wall", expression: "2 mm" }],
        visibility: [{ ref: { token: "body-1" }, visible: false }],
        fillState: "FULL",
        springState: "COCKED",
        routeVariant: "service-route",
        service: { disconnections: ["tank-dock"] },
      };
      const out = await cad("pose.save", payload);
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      const manifest = at(out, "manifest");
      assert.equal(list(at(manifest, "joints")).length, 1, JSON.stringify(out));
      assert.equal(
        list(at(manifest, "parameters")).length,
        1,
        JSON.stringify(out),
      );
      assert.equal(
        list(at(manifest, "visibility")).length,
        1,
        JSON.stringify(out),
      );
      assert.equal(at(manifest, "fillState"), "FULL", JSON.stringify(out));
      assert.equal(at(manifest, "springState"), "COCKED", JSON.stringify(out));
      assert.equal(
        at(manifest, "routeVariant"),
        "service-route",
        JSON.stringify(out),
      );
      assert.deepEqual(
        at(at(manifest, "service"), "disconnections"),
        ["tank-dock"],
        JSON.stringify(out),
      );
    },
  },
  {
    id: "g18-05",
    async run(cad) {
      const full = await cad(
        "pose.save",
        servicePose("Full", { fillState: "FULL" }),
      );
      const empty = await cad(
        "pose.save",
        servicePose("Empty", { fillState: "EMPTY" }),
      );
      assert.equal(at(full, "status"), "pass", JSON.stringify(full));
      assert.equal(at(empty, "status"), "pass", JSON.stringify(empty));
      assert.equal(
        at(at(full, "manifest"), "fillState"),
        "FULL",
        JSON.stringify(full),
      );
      assert.equal(
        at(at(empty, "manifest"), "fillState"),
        "EMPTY",
        JSON.stringify(empty),
      );
      assert.equal(
        at(at(full, "manifest"), "springState"),
        "COCKED",
        JSON.stringify(full),
      );
      assert.deepEqual(
        at(at(at(empty, "manifest"), "service"), "disconnections"),
        ["tank-dock"],
        JSON.stringify(empty),
      );
    },
  },
  {
    id: "g18-06",
    async run(cad) {
      const out = await cad("pose.save", servicePose("Service"));
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.equal(
        at(at(out, "manifest"), "schema"),
        "fmcad.pose.manifest.v1",
        JSON.stringify(out),
      );
      assert.match(
        text(at(out, "method")),
        /not a native ConfigurationTable/,
        JSON.stringify(out),
      );
    },
  },
];
