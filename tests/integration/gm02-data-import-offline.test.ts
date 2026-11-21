import test from "node:test";
import assert from "node:assert/strict";
import { fmcad, at, list, number } from "./offline-cli";

const pose = (x = "0 mm", frame = "parent") => ({
  frame,
  translation: [x, "0 mm", "0 mm"],
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
});

test("gm02: G02-03 catalog check resolves PCBA contents/allocation without double-counting purchases", () => {
  const out = fmcad([
    "catalog",
    "check",
    "--data",
    JSON.stringify({
      version: 1,
      owner: "live",
      revision: "r1",
      records: [
        {
          id: "board",
          name: "Board",
          kind: "pcba",
          quantity: 2,
          purchaseQuantity: 2,
          parent: null,
          placement: pose(),
          status: "CONFIRMED",
          contents: [{ id: "module", quantity: 4 }],
        },
        {
          id: "module",
          name: "Module",
          kind: "purchased",
          parent: "board",
          quantity: 4,
          placement: pose(),
          status: "CONFIRMED",
          allocation: { owner: "board", quantity: 8 },
        },
        {
          id: "outline",
          name: "Outline",
          kind: "reference",
          quantity: 1,
          parent: null,
          placement: pose(),
          status: "CONFIRMED",
        },
      ],
      bom: [
        { id: "module", basis: "contents", quantity: 8 },
        { id: "module", basis: "physical", quantity: 8 },
      ],
    }),
  ]);
  assert.equal(at(out, "operation"), "catalog.check");
  assert.equal(at(out, "result", "counts", "instances"), 11);
  assert.equal(
    list(at(out, "result", "instances")).filter(
      (r) => at(r, "item") === "module",
    ).length,
    8,
  );
  assert.equal(
    at(
      list(at(out, "result", "ledger")).find((r) => at(r, "id") === "module"),
      "purchase",
    ),
    null,
  );
  assert.equal(
    at(
      list(at(out, "result", "ledger")).find((r) => at(r, "id") === "outline"),
      "physical",
    ),
    0,
  );
  assert.deepEqual(at(out, "result", "differences"), []);
  assert.equal(
    at(
      list(at(out, "result", "instances")).find(
        (r) => at(r, "id") === "board:2/module:4",
      ),
      "parent",
    ),
    "board:2",
  );
  assert.equal(at(out, "status"), "unknown"); // vendor masses absent, declared gap
});

test("gm02: G02-04 placement check resolves root-frame poses and refuses missing DOF", () => {
  const ok = fmcad([
    "placement",
    "check",
    "--data",
    JSON.stringify({
      version: 1,
      revision: "r1",
      records: [
        {
          id: "o",
          occurrence: "A:1+B:1",
          placement: pose("1 cm", "root"),
          status: "CONFIRMED",
          source: "live test",
        },
      ],
      observed: { poses: [{ id: "o", transform: pose("1 cm", "root") }] },
    }),
  ]);
  assert.equal(at(ok, "operation"), "placement.check");
  assert.equal(at(ok, "status"), "pass");
  assert.equal(at(ok, "result", "differences", 0, "units"), "cm");
  assert.ok(
    number(at(ok, "result", "differences", 0, "distance")) < 1e-12,
    JSON.stringify(at(ok, "result", "differences")),
  );

  // A mismatching pose fails the check (nonzero exit).
  assert.throws(
    () =>
      fmcad([
        "placement",
        "check",
        "--data",
        JSON.stringify({
          version: 1,
          revision: "r1",
          records: [
            {
              id: "o",
              occurrence: "A:1+B:1",
              placement: pose("1 cm", "root"),
              status: "CONFIRMED",
              source: "live test",
            },
          ],
          observed: { poses: [{ id: "o", transform: pose("11 mm", "root") }] },
        }),
      ]),
    /fail/,
  );

  // A pose without roll/rotation must be refused, not silently filled in.
  assert.throws(
    () =>
      fmcad([
        "placement",
        "check",
        "--data",
        JSON.stringify({
          version: 1,
          revision: "r1",
          records: [
            {
              id: "o",
              occurrence: "A:1",
              placement: {
                frame: "root",
                translation: ["0 mm", "0 mm", "0 mm"],
              },
              status: "CONFIRMED",
            },
          ],
        }),
      ]),
    /rotation/i,
  );
});

test("gm02: G02-05 functional groups stay separate from the rigid physical parent", () => {
  const out = fmcad([
    "catalog",
    "check",
    "--data",
    JSON.stringify({
      version: 1,
      revision: "r1",
      records: [
        {
          id: "P035",
          name: "motor_pinion",
          kind: "part",
          quantity: 3,
          parent: null,
          placement: pose(),
          status: "CONFIRMED",
          functionalGroups: ["PAN", "TILT", "SHOT"],
        },
        {
          id: "C003",
          name: "gearmotor",
          kind: "purchased",
          quantity: 3,
          parent: null,
          placement: pose(),
          status: "CONFIRMED",
          functionalGroups: ["PAN"],
        },
      ],
    }),
  ]);
  const byId = new Map(
    list(at(out, "result", "items")).map((r) => [at(r, "id"), r]),
  );
  assert.deepEqual(at(byId.get("P035"), "functionalGroups"), [
    "PAN",
    "TILT",
    "SHOT",
  ]);
  assert.deepEqual(at(byId.get("C003"), "functionalGroups"), ["PAN"]);
  assert.ok(
    list(at(out, "result", "items")).every((r) => at(r, "parent") === null),
  );
  // The same label used as a rigid parent must fail, not be promoted.
  assert.throws(
    () =>
      fmcad([
        "catalog",
        "check",
        "--data",
        JSON.stringify({
          version: 1,
          revision: "r1",
          records: [
            {
              id: "P035",
              name: "motor_pinion",
              kind: "part",
              quantity: 3,
              parent: "PAN",
              placement: pose(),
              status: "CONFIRMED",
            },
          ],
        }),
      ]),
    /Unknown catalog parent/i,
  );
});

test("gm02: G02-07 whole-file preflight rejects late invalid records before any mutation", () => {
  assert.throws(
    () =>
      fmcad([
        "catalog",
        "check",
        "--data",
        JSON.stringify({
          version: 1,
          revision: "r1",
          records: [
            {
              id: "good",
              name: "Good",
              kind: "part",
              quantity: 1,
              parent: null,
              placement: pose(),
              status: "CONFIRMED",
            },
            {
              id: "bad",
              name: "Bad",
              kind: "part",
              quantity: -1,
              parent: null,
              placement: pose(),
              status: "CONFIRMED",
            },
          ],
        }),
      ]),
    /integer/i,
  );
});

test("gm02: G02-08 catalog import refuses COTS scaling and guessed optical placement", () => {
  // A scalar non-rigid scale is rejected; an optical normal cannot supply roll.
  assert.throws(
    () =>
      fmcad([
        "catalog",
        "check",
        "--data",
        JSON.stringify({
          version: 1,
          revision: "r1",
          records: [
            {
              id: "c",
              name: "COTS",
              kind: "purchased",
              quantity: 1,
              parent: null,
              status: "CONFIRMED",
              placement: {
                frame: "root",
                translation: ["0 mm", "0 mm", "0 mm"],
                rotation: [2, 0, 0, 0, 1, 0, 0, 0, 1],
              },
            },
          ],
        }),
      ]),
    /scale|shear/i,
  );
});

test("gm02: G02-09 generic 145-ID/36-model fixture counts derive from input, not constants", () => {
  const records = Array.from({ length: 145 }, (_, i) => ({
    id: `generic_${i}`,
    name: `G${i}`,
    kind: "part",
    quantity: 1,
    parent: null,
    placement: pose(),
    status: "ESTIMATED",
    ...(i < 36
      ? {
          model: {
            path: "missing-envelope.step",
            representation: "envelope",
            source: "synthetic",
            status: "ESTIMATED",
          },
        }
      : {}),
  }));
  const out = fmcad([
    "catalog",
    "check",
    "--data",
    JSON.stringify({ version: 1, revision: "r1", records }),
  ]);
  assert.deepEqual(at(out, "result", "counts"), {
    ids: 145,
    models: 36,
    instances: 145,
  });
  assert.equal(at(out, "status"), "unknown"); // missing model files remain unresolved
});
