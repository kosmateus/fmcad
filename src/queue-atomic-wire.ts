import { createRequire } from "node:module";
import type { AtomicObservationInput } from "../packages/node-adapters/src/execution/atomic-observation";
import type { ReceiptPreparer } from "../packages/node-adapters/src/execution/recovery-python";
const load = createRequire(__filename);
const adapter = load(
  "./dist/node-adapters/execution/atomic-observation",
) as typeof import("../packages/node-adapters/src/execution/atomic-observation");
export function prepareAtomicObservationWire(
  input: AtomicObservationInput,
): ReturnType<typeof adapter.prepareAtomicObservationWire> {
  const instance = load("./queue-instance") as {
    prepareReceiptScript: ReceiptPreparer;
  };
  return adapter.prepareAtomicObservationWire(
    instance.prepareReceiptScript,
    input,
  );
}
