import test from "node:test";
import assert from "node:assert/strict";
import { fixture, remaining } from "./test-support";
import { simulatorFolder } from "./simulator";
import {
  nativeAnnularBounds,
  nativeSolidsScenarios,
} from "./native-solids-cases";
import { runScenarios } from "./runner";
import { parse } from "./cli";

test("annular-sector bounds include the interior arc extremum rather than only its endpoints", () => {
  // Independent closed-sector extremum calculation, not a modeled Fusion body.
  const radii = [10, 20],
    start = 0,
    end = (2 * Math.PI) / 3;
  const angles = [
    start,
    end,
    ...[0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].filter(
      (a) => a > start && a < end,
    ),
  ];
  const points = radii.flatMap((radius) =>
    angles.map((angle) => [radius * Math.cos(angle), radius * Math.sin(angle)]),
  );
  const spans = [0, 1].map(
    (axis) =>
      Math.max(...points.map((p) => p[axis]!)) -
      Math.min(...points.map((p) => p[axis]!)),
  );
  const expected = [...spans, 5];
  expected.forEach((value, index) =>
    assert.ok(Math.abs(value - nativeAnnularBounds[index]!) < 1e-12),
  );
  assert.ok(
    20 > 20 * Math.sin(end) + 0.001,
    "The historical endpoint-only height excludes actual declared arc points",
  );
  assert.equal(angles.includes(Math.PI / 2), true);
});

for (const protocol of ["mcp", "addin"] as const) {
  test(`native solid obligations refuse unsupported model capability before fixture creation via ${protocol}`, async (t) => {
    const { backend, model, directory } = await fixture(t, protocol);
    const initial = model.executions;
    const reports = await runScenarios(
      backend,
      nativeSolidsScenarios(simulatorFolder, 10),
      directory,
      10,
    );
    assert.equal(
      model.executions,
      initial,
      "Unsupported native family dispatched SDK work",
    );
    assert.equal(reports.length, 10);
    for (const report of reports) {
      assert.equal(report.status, "unsupported");
      assert.equal(report.cleanup, "not-created");
      assert.deepEqual(report.requests, []);
    }
    assert.deepEqual(await remaining(model), { active: null, documents: [] });
  });
}
test("native solid catalog entry requires explicit native run and saved folder", () => {
  assert.throws(
    () => parse(["--backend", "fusion", "--suite", "native-solids"]),
    /requires --run/u,
  );
  assert.throws(
    () => parse(["--backend", "fusion", "--run", "--suite", "native-solids"]),
    /explicitly configured/u,
  );
  assert.equal(
    parse([
      "--backend",
      "fusion",
      "--run",
      "--suite",
      "native-solids",
      "--project-id",
      "project",
      "--folder-id",
      "folder",
    ]).suite,
    "native-solids",
  );
});
