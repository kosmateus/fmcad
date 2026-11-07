import type {
  ConsoleSnapshot,
  ReadObservation,
} from "../application/console-read-model";

/** Passive only: implementations must not probe SDK, start/resume, or change admission. */
export interface ConsoleMetricsPort<T> {
  read(snapshot: ConsoleSnapshot): T;
}
export interface ConsoleReadPort {
  read(): ReadObservation<ConsoleSnapshot>;
}
