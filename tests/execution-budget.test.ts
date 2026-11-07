import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
const load = createRequire(
  path.join(path.resolve(__dirname, "../.."), "package.json"),
);
const { requestTimeout, monotonicMs } = load(
  "./src/request-timeout",
) as typeof import("../packages/node-adapters/src/execution/request-timeout");
test("wrapper deadline admits full RPC or rejects before transport, including later batch steps", () => {
  const env = {
    FMCAD_EXECUTION_DEADLINE_MONOTONIC_MS: String(monotonicMs() + 1250000),
  };
  assert.equal(requestTimeout({ timeoutMs: 1200000 }, env), 1200000);
  const short = {
    FMCAD_EXECUTION_DEADLINE_MONOTONIC_MS: String(monotonicMs() + 5000),
  };
  assert.equal(requestTimeout({ timeoutMs: 1000 }, short), 1000);
  assert.throws(() => requestTimeout({ timeoutMs: 30000 }, short), {
    code: "FMCAD_RPC_NOT_SUBMITTED_BUDGET",
  });
  for (const value of ["NaN", String(monotonicMs() - 1)]) {
    assert.throws(
      () =>
        requestTimeout(
          { timeoutMs: 1000 },
          { FMCAD_EXECUTION_DEADLINE_MONOTONIC_MS: value },
        ),
      /not submitted/,
    );
  }
  assert.throws(() => requestTimeout({ timeoutMs: 0 }, env), /not submitted/);
  assert.equal(
    requestTimeout({ timeoutMs: 180000 }, {}),
    180000,
    "ordinary CLI remains unchanged",
  );
});
