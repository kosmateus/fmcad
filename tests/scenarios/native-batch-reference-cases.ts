import assert from "node:assert/strict";
import path from "node:path";
import type { Scenario } from "./runner";
import { number, record } from "./contracts";
import { nativeResultUncertain, values } from "./native-modeling-support";

export const nativeBatchReferenceCapability = "native-atomic-batch-reference";
/** Retained real-kernel reference regression, using the shared durable unsaved lifecycle. */
export function nativeBatchReferenceScenarios(owners = 10): Scenario[] {
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-batch-reference-" + index,
    scope: "exclusive-instance",
    requires: ["documents", nativeBatchReferenceCapability],
    async run(session) {
      try {
        await session.verifyOwnedUnsaved("observe-batch-reference-before");
        const batch = await session.cad("cad-batch-reference", "batch.run", {
          runId:
            "ref_" +
            session.report.owner.runId.replaceAll("-", "_") +
            "_" +
            index,
          reportPath: session.backend.fusionPath(
            path.join(session.directory, "batch"),
          ),
          operations: [
            {
              id: "seed",
              operation: "shape.box",
              data: {
                name: "OwnedRefBox",
                width: "2 mm",
                depth: "3 mm",
                height: "4 mm",
              },
            },
            {
              id: "gate",
              operation: "check",
              data: {
                measurement: {
                  operation: "measure.volume",
                  data: { ref: { $ref: "seed.result.bodies.0" }, units: "mm3" },
                },
                expected: "24 mm^3",
                tolerance: "0.001 mm^3",
              },
            },
          ],
        });
        if (nativeResultUncertain(batch))
          session.deferCleanup(
            "Native atomic reference outcome is uncertain; preserve the original fixture and receipts without replay",
          );
        assert.equal(batch["success"], true, JSON.stringify(batch));
        assert.equal(record(batch["atomic"])["effective"], true);
        const steps = values(batch["steps"]).map(record);
        assert.deepEqual(
          steps.map((step) => step["status"]),
          ["success", "success"],
        );
        const gate = record(record(record(steps[1])["output"])["result"]);
        assert.ok(
          Math.abs(number(record(gate["actual"])["value"]) - 24) <= 0.001,
        );
        await session.verifyOwnedUnsaved("observe-batch-reference-after");
      } catch (error) {
        if (session.uncertain) throw error;
        // The original regression retained even settled failing fixtures for inspection.
        session.deferCleanup(
          "Retained batch-reference assertion failed; inspect original evidence before cleanup: " +
            String(error),
        );
      }
    },
  }));
}
