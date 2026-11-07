import type { ObservationEvent } from "../domain/observation";

/** Auxiliary events are not execution receipts and must not decide outcomes. */
export interface EventSink {
  publish(event: ObservationEvent): Promise<void>;
  dispose?(): Promise<void> | void;
}
