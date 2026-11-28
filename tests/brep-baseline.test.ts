import type {
  BrepBaselineManifest,
  BrepBaselineReference,
} from "../packages/core/src/ports/brep-baseline";
import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const load = createRequire(
  path.join(process.cwd(), "tests/brep-baseline.test.ts"),
);
const adapterPath = path.resolve(
  "packages/node-adapters/dist/persistence/brep-baseline.js",
);
const { brepBaselineArtifacts } = load(
  adapterPath,
) as typeof import("../packages/node-adapters/src/persistence/brep-baseline");
const pose = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const manifest: BrepBaselineManifest = {
  version: 1,
  scope: "durable",
  source: { document: "scratch", version: "1" },
  frame: "native",
  bodies: [
    { role: "housing", body: "a", instance: "native:root", pose },
    { role: "shaft", body: "b", instance: "native:root", pose },
  ],
};
function fixture(t: import("node:test").TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brep-baseline-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, port: brepBaselineArtifacts(root) };
}

test("owned exact bytes and manifest survive a separate Node process (not native SDK roundtrip)", (t) => {
  const { root, port } = fixture(t);
  const ref = port.publish(manifest, [
    Buffer.from("fake-smt-a"),
    Buffer.from("fake-smt-b"),
  ]);
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const p = require(${JSON.stringify(adapterPath)}).brepBaselineArtifacts(${JSON.stringify(root)});
    const result = p.read(${JSON.stringify(ref)});
    console.log(JSON.stringify({ manifest: result.manifest, bodies: result.exactBodies.map(b => b.toString()) }));
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    manifest,
    bodies: ["fake-smt-a", "fake-smt-b"],
  });
});

test("foreign ownership, traversal, wrong version and limits refuse reads", (t) => {
  const { root, port } = fixture(t);
  const ref = port.publish(manifest, [Buffer.from("a"), Buffer.from("b")]);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "brep-other-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.throws(() => brepBaselineArtifacts(other).read(ref));
  for (const patch of [
    { id: "../escape" },
    { version: 2 },
    { sha256: "0".repeat(64) },
    { path: root },
  ])
    assert.throws(() =>
      port.read({ ...ref, ...patch } as BrepBaselineReference),
    );
  assert.throws(() => brepBaselineArtifacts(root, 1).read(ref));
  assert.throws(() =>
    brepBaselineArtifacts(root, 1).publish(manifest, [
      Buffer.from("a"),
      Buffer.from("b"),
    ]),
  );
});

test("tamper, missing payload, truncated manifest, symlink payload and directory refused", (t) => {
  const { root, port } = fixture(t);
  for (const mutation of [
    "tamper",
    "missing",
    "truncated",
    "symlink",
    "directory",
  ]) {
    const ref = port.publish(manifest, [Buffer.from("a"), Buffer.from("b")]);
    const dir = path.join(root, ".cad/baselines", ref.id);
    const payload = path.join(dir, "0.smt");
    if (mutation === "tamper") fs.writeFileSync(payload, "z");
    if (mutation === "missing") fs.unlinkSync(payload);
    if (mutation === "truncated")
      fs.writeFileSync(path.join(dir, "manifest.json"), "{");
    if (mutation === "symlink") {
      fs.unlinkSync(payload);
      fs.symlinkSync(path.join(dir, "1.smt"), payload);
    }
    if (mutation === "directory") {
      fs.renameSync(dir, `${dir}-moved`);
      fs.symlinkSync(`${dir}-moved`, dir);
    }
    assert.throws(() => port.read(ref), mutation);
  }
});

test("manifest rejects missing identity, duplicate roles, nonfinite pose and payload count", (t) => {
  const { port } = fixture(t);
  for (const mutate of [
    (m: typeof manifest) => {
      m.source.version = "";
    },
    (m: typeof manifest) => {
      m.bodies[1]!.role = m.bodies[0]!.role;
    },
    (m: typeof manifest) => {
      m.bodies[0]!.pose[0] = NaN;
    },
    (m: typeof manifest) => {
      m.bodies[0]!.instance = "";
    },
  ]) {
    const copy = structuredClone(manifest);
    mutate(copy);
    assert.throws(() =>
      port.publish(copy, [Buffer.from("a"), Buffer.from("b")]),
    );
  }
  assert.throws(() => port.publish(manifest, [Buffer.from("a")]));
});
