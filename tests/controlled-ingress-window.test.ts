import assert from "node:assert/strict";
import test from "node:test";
import {
  assertControlledIngressWindow,
  assertControlledIngressTransition,
  readControlledIngressIdentity,
  createControlledIngressWindow,
  type ControlledIngressIdentity,
} from "../packages/node-adapters/src/execution/controlled-ingress-window";

function fixture() {
  let current: ControlledIngressIdentity = {
    owner: { pid: 123, birth: "boot:456", nonce: "broker-1" },
    pins: {
      buildHash: "a".repeat(64),
      configHash: "b".repeat(64),
      generation: "c".repeat(64),
    },
    native: {
      pid: 789,
      birth: "123456",
      source: "d".repeat(40),
      build: "e".repeat(64),
      instance: "instance-1",
      epoch: "epoch-1",
    },
  };
  const expected = structuredClone(current);
  const producer = createControlledIngressWindow(() => current, {
    // Explicit phase doubles: real serve supplies live gate/native assertions.
    assertTransferClosed() {},
    assertActivatedIdle() {},
  });
  return {
    producer,
    expected,
    replace(value: ControlledIngressIdentity) {
      current = value;
    },
  };
}

test("closed service keeps its own authority when diagnostic identity changes at send", async () => {
  const f = fixture();
  const original = f.producer.open();
  const wire = { id: "independent-closed-service" };
  let sends = 0;
  await f.producer.withClosedServiceWire(
    wire,
    () => {},
    async () => {
      f.replace({
        ...f.expected,
        pins: { ...f.expected.pins, buildHash: "f".repeat(64) },
      });
      f.producer.observe(wire);
      sends++;
    },
  );
  assert.equal(sends, 1);
  f.replace(f.expected);
  assert.throws(() => assertControlledIngressWindow(original, f.expected));
});

test("original private window permits only the exact certificate-fenced wire across awaits", async () => {
  const f = fixture();
  const original = f.producer.open();
  const wire = { id: "rpc-1", params: { code: "exact wrapped program" } };
  const bytes = JSON.stringify(wire);
  let sends = 0;
  const result = await f.producer.withStdoutWire(
    wire,
    () => {
      assert.equal(JSON.stringify(wire), bytes);
    },
    async () => {
      await Promise.resolve();
      f.producer.observe(wire);
      sends++;
      return "original stdout";
    },
  );
  assert.equal(result, "original stdout");
  assert.equal(sends, 1);
  assertControlledIngressWindow(original, f.expected);
  assert.throws(
    () => assertControlledIngressWindow(structuredClone(original), f.expected),
    /Original current/,
  );
  assert.throws(() => f.producer.open(), /Original current/);
});

test("same-data clone on the send boundary is denied before transport", async () => {
  const f = fixture();
  const original = f.producer.open();
  const wire = { id: "rpc-1" };
  let sends = 0;
  await assert.rejects(
    f.producer.withStdoutWire(
      wire,
      () => {},
      async () => {
        f.producer.observe(structuredClone(wire));
        sends++;
      },
    ),
    /Original current/,
  );
  assert.equal(sends, 0);
  assert.throws(() => assertControlledIngressWindow(original, f.expected));
});

test("wire code tamper is checked again at the actual transport boundary", async () => {
  const f = fixture();
  f.producer.open();
  const wire = { code: "original" };
  let sends = 0;
  await assert.rejects(
    f.producer.withStdoutWire(
      wire,
      () => {
        assert.equal(wire.code, "original");
      },
      async () => {
        await Promise.resolve();
        wire.code = "substituted";
        f.producer.observe(wire);
        sends++;
      },
    ),
    /substituted/,
  );
  assert.equal(sends, 0);
});

test("an independent unqualified physical call revokes instead of borrowing another async scope", async () => {
  const f = fixture();
  const original = f.producer.open();
  const wire = { id: "owned" };
  let ready!: () => void;
  let resume!: () => void;
  const reached = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let sends = 0;
  const pending = f.producer.withStdoutWire(
    wire,
    () => {},
    async () => {
      ready();
      await barrier;
      f.producer.observe(wire);
      sends++;
    },
  );
  await reached;
  // This is a distinct async client, not a nested call of the stdout sender.
  f.producer.observe({ id: "ordinary-other-operation" });
  resume();
  await assert.rejects(pending, /Original current/);
  assert.equal(sends, 0);
  assert.throws(() => assertControlledIngressWindow(original, f.expected));
});

test("owner/native generation change during await is terminal even if restored", async () => {
  const f = fixture();
  const original = f.producer.open();
  const wire = { id: "owned" };
  let sends = 0;
  await assert.rejects(
    f.producer.withStdoutWire(
      wire,
      () => {},
      async () => {
        await Promise.resolve();
        const changed = structuredClone(f.expected);
        f.replace({
          ...changed,
          native: { ...changed.native, epoch: "successor" },
        });
        f.producer.observe(wire);
        sends++;
      },
    ),
    /Original current/,
  );
  assert.equal(sends, 0);
  f.replace(f.expected);
  assert.throws(() => assertControlledIngressWindow(original, f.expected));
});

test("loss after a real send is not misrepresented as pre-send denial", async () => {
  const f = fixture();
  const original = f.producer.open();
  const wire = { id: "owned" };
  let sends = 0;
  await assert.rejects(
    f.producer.withStdoutWire(
      wire,
      () => {},
      async () => {
        f.producer.observe(wire);
        sends++;
        await Promise.resolve();
        f.producer.revoke();
        return "already executed";
      },
    ),
    /Original current/,
  );
  assert.equal(sends, 1);
  assert.throws(() => assertControlledIngressWindow(original, f.expected));
});

test("rejecting asynchronous certificate fence is denied and its rejection handled", async () => {
  const f = fixture();
  f.producer.open();
  let sends = 0;
  await assert.rejects(
    f.producer.withStdoutWire(
      {},
      (() =>
        Promise.reject(
          new Error("async certificate"),
        )) as unknown as () => void,
      async () => {
        sends++;
      },
    ),
    /Original current/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(sends, 0);
});

test("paused transfer witness is not an active dispatch grant and survives an early eligibility read", async () => {
  const f = fixture();
  const original = f.producer.sealForTransfer();
  assertControlledIngressTransition(original, f.expected);
  assert.deepEqual(readControlledIngressIdentity(original), f.expected);
  assert.throws(() => assertControlledIngressWindow(original, f.expected));
  let sends = 0;
  await assert.rejects(
    f.producer.withStdoutWire(
      {},
      () => {},
      async () => {
        sends++;
      },
    ),
  );
  assert.equal(sends, 0);
  assertControlledIngressTransition(original, f.expected);
  assert.equal(f.producer.open(), original);
  assertControlledIngressWindow(original, f.expected);
});

test("closed receipt-bound readiness service can finish before activation without admitting arbitrary sends", async () => {
  const f = fixture();
  const original = f.producer.sealForTransfer();
  const wire = { id: "fixed-readiness" };
  let fences = 0;
  let sends = 0;
  await f.producer.withClosedServiceWire(
    wire,
    () => {
      fences++;
    },
    async () => {
      await Promise.resolve();
      f.producer.observe(wire);
      sends++;
    },
  );
  assert.equal(sends, 1);
  assert.ok(fences >= 2);
  assertControlledIngressTransition(original, f.expected);
  f.producer.open();
  assertControlledIngressWindow(original, f.expected);
});

test("revoking the diagnostic window does not block an independently authorized closed service", async () => {
  const f = fixture();
  const original = f.producer.open();
  f.producer.observe({ id: "ordinary-physical-operation" });
  assert.throws(() => assertControlledIngressWindow(original, f.expected));
  const wire = { id: "own-closed-service" };
  let checks = 0;
  let sends = 0;
  await f.producer.withClosedServiceWire(
    wire,
    () => {
      checks++;
    },
    async () => {
      f.producer.observe(wire);
      sends++;
    },
  );
  assert.equal(sends, 1);
  assert.ok(checks >= 2);
  assert.throws(() => assertControlledIngressWindow(original, f.expected));
  await assert.rejects(
    f.producer.withClosedServiceWire(
      wire,
      () => {
        throw new Error("Own certificate revoked");
      },
      async () => {
        sends++;
      },
    ),
    /Own certificate revoked/,
  );
  assert.equal(sends, 1);
});
