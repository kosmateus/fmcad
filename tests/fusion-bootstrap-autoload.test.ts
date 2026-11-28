import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  planControlledFusionAutoload,
  matchesControlledFusionAutoload,
  planNormalObserverAutoload,
  planOwnedBootstrapAutoload,
  matchesOwnedBootstrapAutoload,
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
test("owned bootstrap disables foreign startup without qualifying isolation or manual ALL-OFF", () => {
  const value = fixture();
  const original = bytes(value);
  const plan = planOwnedBootstrapAutoload(original, fork);
  assert.equal(plan.authority, "NONE");
  assert.equal(plan.isolation, "NOT_PROVEN");
  assert.equal(plan.forkStart, "owned-startup-after-native-rebind");
  assert.deepEqual(JSON.parse(plan.registrationBytes().toString()), {
    loadedScripts: value.loadedScripts.map((row) => ({
      ...row,
      runOnStartup: row.path === fork,
    })),
  });
  assert.equal(
    matchesControlledFusionAutoload(plan.registrationBytes(), fork),
    false,
  );
  assert.equal(
    matchesOwnedBootstrapAutoload(plan.registrationBytes(), fork),
    true,
  );
  assert.equal(matchesOwnedBootstrapAutoload(original, fork), false);
  assert.equal(
    matchesOwnedBootstrapAutoload(
      planControlledFusionAutoload(original, fork).registrationBytes(),
      fork,
    ),
    false,
  );
  assert.equal(
    matchesOwnedBootstrapAutoload(
      planNormalObserverAutoload(original, fork).registrationBytes(),
      fork,
    ),
    false,
  );
  const copy = plan.registrationBytes();
  copy.fill(0);
  assert.equal(
    createHash("sha256").update(plan.registrationBytes()).digest("hex"),
    plan.plannedSha256,
  );
  assert.deepEqual(JSON.parse(original.toString()), value);
  const removed = fixture();
  removed.loadedScripts[2]!.isRemoved = true;
  assert.throws(() => planOwnedBootstrapAutoload(bytes(removed), fork));
  const ambiguous = fixture();
  ambiguous.loadedScripts.push({ ...ambiguous.loadedScripts[2]! });
  assert.throws(() => planOwnedBootstrapAutoload(bytes(ambiguous), fork));
});
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

test("normal observer enables only the exact fork and preserves every foreign registration", () => {
  const value = fixture();
  value.loadedScripts[0]!.isRemoved = true;
  const original = bytes(value);
  const plan = planNormalObserverAutoload(
    original,
    fork.toUpperCase().replaceAll("/", "\\"),
  );
  assert.equal(plan.kind, "normal-observer-autoload-plan-v1");
  assert.equal(plan.authority, "NONE");
  assert.equal(plan.isolation, "NOT_PROVEN");
  assert.equal(plan.forkStart, "normal-startup");
  assert.equal(plan.installedForkEntry, fork);
  assert.equal(
    plan.originalSha256,
    createHash("sha256").update(original).digest("hex"),
  );
  const output = plan.registrationBytes();
  assert.equal(
    plan.plannedSha256,
    createHash("sha256").update(output).digest("hex"),
  );
  const planned = JSON.parse(output.toString());
  assert.deepEqual(
    planned.loadedScripts,
    value.loadedScripts.map((row, index) =>
      index === 2 ? { ...row, runOnStartup: true } : row,
    ),
  );
  output.fill(0);
  original.fill(0);
  assert.deepEqual(JSON.parse(plan.registrationBytes().toString()), planned);
});

test("normal observer startup is never accepted as a controlled all-OFF registration", () => {
  const original = planControlledFusionAutoload(
    bytes(fixture()),
    fork,
  ).registrationBytes();
  assert.equal(matchesControlledFusionAutoload(original, fork), true);
  const observer = planNormalObserverAutoload(original, fork);
  assert.equal(
    matchesControlledFusionAutoload(observer.registrationBytes(), fork),
    false,
  );
  assert.equal(matchesControlledFusionAutoload(original, fork), true);
});

test("normal observer cannot select by basename or enable a missing, removed or duplicate fork", () => {
  const missing = fixture();
  missing.loadedScripts[2]!.path =
    "D:/Other/AutodeskFusionMCP/AutodeskFusionMCP.py";
  const removed = fixture();
  removed.loadedScripts[2]!.isRemoved = true;
  const duplicate = fixture();
  duplicate.loadedScripts.push({
    ...duplicate.loadedScripts[2]!,
    path: fork.toUpperCase(),
  });
  for (const input of [missing, removed, duplicate]) {
    const original = bytes(input);
    assert.throws(() => planNormalObserverAutoload(original, fork), {
      code: "FUSION_AUTOLOAD_UNPROVEN",
    });
    assert.deepEqual(JSON.parse(original.toString()), input);
  }
});

test("normal observer refuses malformed and unknown profile data rather than dropping it", () => {
  for (const input of [
    Buffer.from([0xff]),
    Buffer.from('{"loadedScripts":[],"loadedScripts":[]}'),
    bytes({ loadedScripts: fixture().loadedScripts, extra: true }),
    bytes({ loadedScripts: [{ ...fixture().loadedScripts[2]!, extra: true }] }),
  ]) {
    assert.throws(() => planNormalObserverAutoload(input, fork), {
      code: "FUSION_AUTOLOAD_UNPROVEN",
    });
  }
});
