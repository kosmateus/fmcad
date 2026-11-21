import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import type { QueueDomainOptions, QueueSnapshot } from "@fmcad/core";
const load = createRequire(__filename);
const { QueueDomain, terminal, validateQueueOptions } = load(
  "./dist/core/domain/queue",
) as typeof import("../packages/core/src/domain/queue");
const { createSnapshotStore } = load(
  "./dist/node-adapters/persistence/records",
) as typeof import("../packages/node-adapters/src/persistence/records");
export { terminal };
export interface QueueStateOptions extends Partial<
  Omit<QueueDomainOptions, "snapshot" | "newId" | "hash" | "commit">
> {
  expectedSnapshotHash?: string;
  onCommittedSnapshot?(snapshot: QueueSnapshot, directory: string): void;
}
function monotonicEpoch(): () => number {
  const epoch = Date.now(),
    start = performance.now();
  return () => Math.floor(epoch + performance.now() - start);
}
/** Existing domain restoration validates persisted transitions before they can execute. */
export class QueueState extends QueueDomain {
  readonly dir: string;
  readonly file: string;
  constructor(dir: string, options: QueueStateOptions = {}) {
    const now = options.now === undefined ? monotonicEpoch() : options.now;
    validateQueueOptions({ ...options, now });
    const store = createSnapshotStore(dir);
    let serialized = store.restore();
    let snapshot: QueueSnapshot | undefined;
    if (serialized !== null) {
      try {
        // QueueDomain is the retained persisted snapshot decoder. The exact
        // parsed bytes reach its constructor; host composition does not normalize.
        snapshot = JSON.parse(serialized) as QueueSnapshot;
      } catch (error) {
        throw Object.assign(
          new Error(
            `Cannot restore queue snapshot: ${error instanceof Error ? error.message : String(error)}`,
          ),
          { code: "CORRUPT_STATE" },
        );
      }
    }
    if (
      options.expectedSnapshotHash &&
      createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") !==
        options.expectedSnapshotHash
    )
      throw Object.assign(
        new Error("Migration escrow snapshot changed before construction"),
        { code: "MIGRATION_FENCE_CHANGED" },
      );
    super({
      ...options,
      snapshot,
      now,
      newId: () => randomUUID(),
      hash: (text) => createHash("sha256").update(text).digest("hex"),
      commit(draft) {
        const text = JSON.stringify(draft);
        if (text !== serialized) {
          store.commit(text);
          serialized = text;
          try {
            options.onCommittedSnapshot?.(draft, path.resolve(dir));
          } catch {
            /* Passive transition telemetry. */
          }
        }
      },
    });
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, "queue-state.json");
  }
}
