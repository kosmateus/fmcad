import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  planControlledFusionAutoload,
  matchesControlledFusionAutoload,
} from "../packages/node-adapters/src/execution/fusion-bootstrap-autoload";

const fork = "C:/Users/operator/AddIns/AutodeskFusionMCP/AutodeskFusionMCP.py";
const fixture = () => ({
  loadedScripts: [
    {
      name: "Vendor",
      path: "_INTERNAL_ADDINS_PATH_Vendor/Vendor.py",
      location: 4,
      isRemoved: false,
      isFavorite: true,
      runOnStartup: true,
    },
    {
      name: "External",
      path: "D:/External/External.py",
      location: 3,
      isRemoved: false,
      isFavorite: false,
      runOnStartup: true,
    },
    {
      name: "AutodeskFusionMCP",
      path: fork,
      location: 3,
      isRemoved: false,
      isFavorite: false,
      runOnStartup: false,
    },
  ],
});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
test("controlled autoload changes only startup flags and binds exact original bytes", () => {
  const value = fixture(),
    original = bytes(value);
  const plan = planControlledFusionAutoload(original, fork);
  assert.equal(plan.authority, "NONE");
  assert.equal(
    plan.originalSha256,
    createHash("sha256").update(original).digest("hex"),
  );
  const planned = JSON.parse(plan.registrationBytes().toString());
  assert.deepEqual(
    planned.loadedScripts,
    value.loadedScripts.map((row) => ({
      ...row,
      runOnStartup: false,
    })),
  );
  assert.equal(matchesControlledFusionAutoload(original, fork), false);
  assert.equal(
    matchesControlledFusionAutoload(plan.registrationBytes(), fork),
    true,
  );
  const copy = plan.registrationBytes();
  copy.fill(0);
  assert.equal(
    matchesControlledFusionAutoload(plan.registrationBytes(), fork),
    true,
  );
  assert.deepEqual(JSON.parse(original.toString()), value);
});
test("missing, removed or ambiguous fork entries cannot qualify a registration", () => {
  const missing = fixture();
  missing.loadedScripts.pop();
  assert.throws(() => planControlledFusionAutoload(bytes(missing), fork), {
    code: "FUSION_AUTOLOAD_UNPROVEN",
  });
  const removed = fixture();
  removed.loadedScripts[2]!.isRemoved = true;
  assert.throws(() => planControlledFusionAutoload(bytes(removed), fork), {
    code: "FUSION_AUTOLOAD_UNPROVEN",
  });
  const duplicate = fixture();
  duplicate.loadedScripts.push({
    ...duplicate.loadedScripts[2]!,
    path: fork.toUpperCase().replaceAll("/", "\\"),
  });
  assert.throws(() => planControlledFusionAutoload(bytes(duplicate), fork), {
    code: "FUSION_AUTOLOAD_UNPROVEN",
  });
});
test("unknown registration schemas and malformed bytes are refused instead of dropped", () => {
  for (const value of [
    { loadedScripts: [], extra: true },
    {
      loadedScripts: [{ ...fixture().loadedScripts[2], runOnStartup: "true" }],
    },
    {
      loadedScripts: [{ ...fixture().loadedScripts[2], extra: "unrecognized" }],
    },
    {
      loadedScripts: fixture().loadedScripts.map((row, index) =>
        index === 0 ? { ...row, path: "invalid\0entry.py" } : row,
      ),
    },
  ]) {
    assert.throws(() => planControlledFusionAutoload(bytes(value), fork), {
      code: "FUSION_AUTOLOAD_UNPROVEN",
    });
  }
  assert.throws(() => planControlledFusionAutoload(Buffer.from([0xff]), fork), {
    code: "FUSION_AUTOLOAD_UNPROVEN",
  });
  assert.throws(
    () =>
      planControlledFusionAutoload(
        Buffer.from('{"loadedScripts":[],"loadedScripts":[]}'),
        fork,
      ),
    {
      code: "FUSION_AUTOLOAD_UNPROVEN",
    },
  );
});
