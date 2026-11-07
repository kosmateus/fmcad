import type { InvocationContext } from "../domain/observation";

/** Each presence port instance owns only the invocation instance it was given. */
export interface Presence {
  heartbeat(invocation: InvocationContext, atMs: number): Promise<void>;
  dispose(invocation: InvocationContext, atMs: number): Promise<void>;
}
