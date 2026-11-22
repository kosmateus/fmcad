import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const load = createRequire(
  new URL("../src/queue-instance.js", import.meta.url),
);
const { validateNativeRootSuccession } = load(
  "./dist/node-adapters/execution/runtime-root-successor",
);
const physicalRuntime = {
  pid: 41,
  birth: "birth",
  version: "version",
  source: "source",
  build: "build",
};
const generation = (index) => ({
  instance: `instance-${index}`,
  epoch: `epoch-${index}`,
});
function fixture(count = 1) {
  const originalRuntime = {
    handoffId: "h0",
    generation: generation(0),
    physicalRuntime,
    endpointURL: "http://127.0.0.1:8765/mcp",
  };
  const currentRuntime = {
    ...originalRuntime,
    handoffId: `h${count}`,
    generation: generation(count),
  };
  const context = {
    requestId: "original-consumed",
    admissionStore: "C:\\private\\admission.sqlite3",
    originalRuntime,
    currentRuntime,
  };
  const value = {
    kind: "fmcad-runtime-root-successor-v1",
    version: 1,
    requestId: context.requestId,
    retirement: { handoffId: "h1", nextGeneration: generation(1) },
    handoffs: Array.from({ length: count }, (_, index) => ({
      handoffId: `h${index + 1}`,
      generation: generation(index),
      nextGeneration: generation(index + 1),
      state: "committed",
    })),
    currentRuntime,
    database: {
      path: context.admissionStore,
      device: "4824059094287526125",
      inode: "15762598695943238",
    },
  };
  return { context: structuredClone(context), value: structuredClone(value) };
}
test("same-generation root needs no successor claim", () => {
  const f = fixture(0);
  assert.equal(validateNativeRootSuccession(null, f.context), false);
  assert.equal(validateNativeRootSuccession(undefined, f.context), false);
});
for (const count of [1, 2, 12]) {
  test(`native root validates ${count} exact committed successor links without lossy inode conversion`, () => {
    const f = fixture(count);
    assert.equal(validateNativeRootSuccession(f.value, f.context), true);
  });
}
const corruptions = {
  missing: (f) => {
    f.value = null;
  },
  request: (f) => {
    f.value.requestId = "another";
  },
  store: (f) => {
    f.value.database.path = "C:\\another.sqlite3";
  },
  lossyInode: (f) => {
    f.value.database.inode = 15762598695943238;
  },
  ambiguousInode: (f) => {
    f.value.database.inode = "015762598695943238";
  },
  runtime: (f) => {
    f.value.currentRuntime.physicalRuntime.pid++;
  },
  handoff: (f) => {
    f.value.currentRuntime.handoffId = "foreign";
  },
  retirement: (f) => {
    f.value.retirement.nextGeneration = generation(99);
  },
  pending: (f) => {
    f.value.handoffs[0].state = "pending";
  },
  disconnected: (f) => {
    f.value.handoffs[1].generation = generation(99);
  },
  cycle: (f) => {
    f.value.handoffs[1].nextGeneration = generation(0);
  },
  reusedHandoff: (f) => {
    f.value.handoffs[1].handoffId = "h1";
  },
  truncated: (f) => {
    f.value.handoffs.pop();
  },
  extraAuthority: (f) => {
    f.value.authorized = true;
  },
};
for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`native succession refuses ${name}`, () => {
    const f = fixture(2);
    corrupt(f);
    assert.throws(() => validateNativeRootSuccession(f.value, f.context), {
      code: "RUNTIME_BARRIER_CHANGED",
    });
  });
}
