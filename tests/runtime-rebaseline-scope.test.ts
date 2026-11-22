import assert from "node:assert/strict";
import test from "node:test";
import { runtimeRebaselineManifestNames } from "../packages/node-adapters/src/persistence/runtime-rebaseline-scope";

const root = "/private/store";
const inputs = [
  "physical-backend-head.json",
  "isolated-admission-epoch.json",
  "instance.json",
  "queue-state.json",
  "queue-state.pending.json",
  "runtime-rebaseline-head.json",
];

test("literal root and active epoch manifests use the same stable complete ordering", () => {
  assert.deepEqual(runtimeRebaselineManifestNames(root, null), inputs);
  assert.deepEqual(
    runtimeRebaselineManifestNames(
      root,
      Buffer.from(
        JSON.stringify({
          epochId: "epoch_1",
          root: root + "/admission-epochs/epoch_1",
        }),
      ),
    ),
    [
      ...inputs,
      "admission-epochs/epoch_1/instance.json",
      "admission-epochs/epoch_1/queue-state.json",
      "admission-epochs/epoch_1/queue-state.pending.json",
    ],
  );
});

test("epoch scope rejects arbitrary roots, traversal, malformed objects and byte aliases", () => {
  for (const pointer of [
    '{"epochId":"../outside","root":"/outside"}',
    '{"epochId":"epoch","root":"/outside"}',
    '{"epochId":"epoch","root":"/private/store/admission-epochs/epoch/."}',
    '{"epochId":1,"root":"/private/store/admission-epochs/1"}',
    "null",
    "[]",
    '{"epochId":"epoch","epochId":"other","root":"x"}',
  ])
    assert.throws(() =>
      runtimeRebaselineManifestNames(root, Buffer.from(pointer)),
    );
  assert.throws(() =>
    runtimeRebaselineManifestNames(root, Buffer.from([0xff])),
  );
});
