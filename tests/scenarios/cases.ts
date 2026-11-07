import assert from "node:assert/strict";
import type { Scenario } from "./runner";
import { number } from "./contracts";
import * as programs from "./programs";

export const lifecycle: Scenario = {
  id: "document-lifecycle",
  requires: ["documents", "fixture-export"],
  async run(session) {
    const state = await session.execute(
      "inspect",
      programs.inspect(session.document),
      session.document,
    );
    assert.equal(state["creationId"], session.document.creationId);
    assert.equal(state["count"], 0);
    assert.equal(state["saved"], false);
  },
};
/** Same parameter name across owners exposes accidental active-document routing. */
export function parameterScenario(index: number): Scenario {
  const valueMm = index + 2;
  return {
    id: "parameters-" + index,
    requires: ["documents", "fixture-export", "literal-length-parameters"],
    async run(session) {
      const write = await session.execute(
        "write",
        programs.parameter(session.document, valueMm),
        session.document,
      );
      assert.equal(write["creationId"], session.document.creationId);
      assert.equal(write["count"], 1);
      // Preserved from live-normal-multidocument: mm input, cm API value, 1e-9 tolerance.
      assert.ok(Math.abs(number(write["value"]) - valueMm / 10) < 1e-9);
      const read = await session.execute(
        "read",
        programs.parameter(session.document),
        session.document,
      );
      assert.equal(read["creationId"], session.document.creationId);
      assert.equal(read["count"], 1);
      assert.ok(Math.abs(number(read["value"]) - valueMm / 10) < 1e-9);
    },
  };
}
export function foundationScenarios(owners = 10): Scenario[] {
  if (!Number.isSafeInteger(owners) || owners < 1)
    throw new Error("owners must be a positive integer");
  return [
    lifecycle,
    ...Array.from({ length: owners }, (_, index) => parameterScenario(index)),
  ];
}
