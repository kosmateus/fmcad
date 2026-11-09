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

export const cases: readonly DeclarationCase[] = [
  {
    id: "g13-01",
    async run(cad) {
      const out = await cad("thread.catalog", {
        schemaVersion: 1,
        frame: "component",
        system: "iso-metric-coarse",
        query: "M10",
      });
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.equal(at(out, "system"), "iso-metric-coarse");
      assert.equal(at(out, "curated"), true);
      assert.equal(list(at(out, "entries")).length, 1);
      const entry = at(at(out, "entries"), 0);
      assert.equal(at(entry, "designation"), "M10");
      assert.equal(at(at(entry, "pitch"), "value"), 1.5);
      assert.equal(at(at(entry, "lead"), "value"), 1.5);
      assert.equal(at(at(entry, "majorDiameter"), "value"), 10);
      assert.equal(at(entry, "starts"), 1);
      assert.equal(at(entry, "hand"), "right");
    },
  },
  {
    id: "g13-02",
    async run(cad) {
      const out = await cad("model.thread", {
        faces: [{ token: "cylinder-face-token" }],
        internal: false,
        profile: {
          majorDiameter: "10 mm",
          pitch: "1.5 mm",
          starts: 2,
          hand: "right",
        },
      });
      // A custom profile is a computational recipe, never a texture or a fake native feature.
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.equal(at(out, "representation"), "recipe");
      assert.equal(at(out, "modeled"), true);
      assert.equal(at(out, "feature"), null);
      assert.ok(
        number(
          Math.abs(number(number(at(at(out, "lead"), "value")) - number(3.0))),
        ) < number(1e-6),
        JSON.stringify(at(out, "lead")),
      );
      assert.equal(at(out, "starts"), 2);
      assert.equal(at(out, "hand"), "right");
    },
  },
  {
    id: "g13-03",
    async run(cad) {
      const out = await cad("thread.custom-profile", {
        schemaVersion: 1,
        frame: "component",
        majorDiameter: "10 mm",
        pitch: "1.5 mm",
        starts: 3,
        hand: "right",
        flankAngle: "60 deg",
        rootShape: "flat",
        length: "20 mm",
        runout: "1.5 mm",
        clearance: "0.1 mm",
      });
      assert.equal(at(out, "status"), "pass", JSON.stringify(out));
      assert.equal(at(out, "representation"), "recipe");
      const profile = at(out, "profile");
      assert.equal(at(at(profile, "majorDiameter"), "value"), 10);
      assert.ok(
        number(
          Math.abs(
            number(number(at(at(profile, "pitch"), "value")) - number(1.5)),
          ),
        ) < number(1e-6),
        JSON.stringify(at(profile, "pitch")),
      );
      assert.equal(at(profile, "starts"), 3);
      assert.ok(
        number(
          Math.abs(
            number(number(at(at(profile, "lead"), "value")) - number(4.5)),
          ),
        ) < number(1e-6),
        JSON.stringify(at(profile, "lead")),
      );
      assert.equal(at(profile, "hand"), "right");
      assert.ok(
        number(
          Math.abs(
            number(
              number(at(at(profile, "turnsPerLength"), "value")) -
                number(number(1) / number(4.5)),
            ),
          ),
        ) < number(1e-9),
      );
      // minorDiameter = major - 1.226869*pitch; depth = (major - minor) / 2.
      const expectedDepth = number(number(1.226869) * number(1.5)) / number(2);
      assert.ok(
        number(
          Math.abs(
            number(
              number(at(at(profile, "depth"), "value")) - number(expectedDepth),
            ),
          ),
        ) < number(1e-6),
        JSON.stringify(at(profile, "depth")),
      );
    },
  },
  {
    id: "g13-04",
    async run(cad) {
      const rh = await cad("thread.pair-check", {
        schemaVersion: 1,
        frame: "component",
        external: {
          majorDiameter: "10 mm",
          minorDiameter: "8.16 mm",
          pitch: "1.5 mm",
          starts: 1,
          hand: "right",
        },
        internal: {
          majorDiameter: "10 mm",
          minorDiameter: "8.38 mm",
          pitch: "1.5 mm",
          starts: 1,
          hand: "right",
        },
      });
      assert.equal(at(rh, "status"), "pass", JSON.stringify(rh));
      assert.equal(at(rh, "pairFit"), "pass");
      assert.ok(
        number(
          Math.abs(
            number(
              number(at(at(rh, "engagementDepth"), "value")) -
                number(number(number(10) - number(8.38)) / number(2)),
            ),
          ),
        ) < number(1e-6),
      );
      // Hand mismatch fails (exits nonzero with the fail envelope on stdout).
      await assert.rejects(
        async () =>
          await cad("thread.pair-check", {
            schemaVersion: 1,
            frame: "component",
            external: {
              majorDiameter: "10 mm",
              minorDiameter: "8.16 mm",
              pitch: "1.5 mm",
              starts: 1,
              hand: "right",
            },
            internal: {
              majorDiameter: "10 mm",
              minorDiameter: "8.38 mm",
              pitch: "1.5 mm",
              starts: 1,
              hand: "left",
            },
          }),
        /hands must match/,
      );
    },
  },
  {
    id: "g13-05",
    async run(cad) {
      // Both minorDiameter and pitchDiameter is contradictory.
      await assert.rejects(
        async () =>
          await cad("thread.custom-profile", {
            schemaVersion: 1,
            frame: "component",
            majorDiameter: "10 mm",
            minorDiameter: "8 mm",
            pitchDiameter: "9 mm",
            pitch: "1.5 mm",
          }),
        /minorDiameter or pitchDiameter/,
      );
      // Equal lead but mismatched starts fails (lead equality alone is not enough).
      await assert.rejects(
        async () =>
          await cad("thread.pair-check", {
            schemaVersion: 1,
            frame: "component",
            external: {
              majorDiameter: "10 mm",
              minorDiameter: "8.16 mm",
              pitch: "1.5 mm",
              starts: 2,
              hand: "right",
            },
            internal: {
              majorDiameter: "10 mm",
              minorDiameter: "8.38 mm",
              pitch: "3.0 mm",
              starts: 1,
              hand: "right",
            },
          }),
        /starts must match/,
      );
    },
  },
  {
    id: "g13-06",
    async run(cad) {
      // Single start: lead = starts * pitch = 1.5 mm/turn.
      const single = await cad("thread.custom-profile", {
        schemaVersion: 1,
        frame: "component",
        majorDiameter: "10 mm",
        pitch: "1.5 mm",
        starts: 1,
        hand: "right",
      });
      assert.equal(at(single, "status"), "pass", JSON.stringify(single));
      assert.ok(
        number(
          Math.abs(
            number(
              number(at(at(at(single, "profile"), "lead"), "value")) -
                number(1.5),
            ),
          ),
        ) < number(1e-6),
        JSON.stringify(at(at(single, "profile"), "lead")),
      );
      // Two starts at 1.5 mm pitch: lead = 3 mm/turn, recipe-only (declared native gap).
      const multi = await cad("model.thread", {
        faces: [{ token: "cylinder-face-token" }],
        internal: false,
        profile: {
          majorDiameter: "10 mm",
          pitch: "1.5 mm",
          starts: 2,
          hand: "right",
        },
      });
      assert.equal(at(multi, "status"), "pass", JSON.stringify(multi));
      assert.ok(
        number(
          Math.abs(
            number(number(at(at(multi, "lead"), "value")) - number(3.0)),
          ),
        ) < number(1e-6),
        JSON.stringify(at(multi, "lead")),
      );
      assert.equal(at(multi, "starts"), 2);
      assert.equal(at(multi, "feature"), null);
      assert.match(text(at(multi, "note")), /declared native gap/);
    },
  },
];
