import path from "node:path";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import type { QueueDomainOptions, QueueSnapshot } from "@fmcad/core";
const load = createRequire(__filename);
const { QueueDomain, terminal, validateQueueOptions } = load(
  "./dist/core/domain/queue",
) as typeof import("../packages/core/src/domain/queue");
const { createSnapshotStore, readBytes, MAX_JSON_RECORD_BYTES } = load(
  "./dist/node-adapters/persistence/records",
) as typeof import("../packages/node-adapters/src/persistence/records");
export { terminal };
export interface QueueStateOptions extends Partial<
  Omit<QueueDomainOptions, "snapshot" | "newId" | "hash" | "commit">
> {
  expectedSnapshotHash?: string;
  onCommittedSnapshot?(snapshot: QueueSnapshot, directory: string): void;
  /** Host-owned namespace containing the original, immutable physical intents. */
  physicalCatalogDirectory?: string;
}
function assertPhysicalCatalog(snapshot: QueueSnapshot, directory: string) {
  try {
    for (const job of Object.values(snapshot.jobs)) {
      const entries = job.physicalDispatches;
      if (!entries?.length) {
        if (snapshot.quarantined?.[job.id])
          throw Error("Missing physical catalog");
        continue;
      }
      if (path.basename(job.id) !== job.id)
        throw Error("Foreign physical catalog");
      const root = path.join(directory, "jobs", job.id);
      const files = fs
        .readdirSync(root)
        .filter((name) => /^physical-turn-[a-f0-9]{64}\.json$/.test(name));
      if (
        files.length !== entries.length ||
        files.some(
          (name) => !entries.some((entry) => entry.intentReference === name),
        )
      )
        throw Error("Physical catalog is incomplete");
      for (const entry of entries) {
        if (!/^physical-turn-[a-f0-9]{64}\.json$/.test(entry.intentReference))
          throw Error("Foreign intent path");
        if (typeof entry.physical?.turnId !== "string" ||
            !/^[A-Za-z0-9_-]{1,256}$/.test(entry.physical.turnId))
          throw Error("Foreign original RPC path");
        const file = path.join(root, entry.intentReference);
        const bytes = readBytes(file, MAX_JSON_RECORD_BYTES, fs, file);
        if (
          createHash("sha256").update(bytes).digest("hex") !==
            entry.intentDigest ||
          !isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), {
            request: entry.request,
            physical: entry.physical,
            target: entry.target,
          })
        )
          throw Error("Original physical intent changed");
        if (entry.request.kind === "product") {
          const rpc = path.join(root, `rpc-${entry.physical.turnId}.json`);
          const original = JSON.parse(
            readBytes(rpc, MAX_JSON_RECORD_BYTES, fs, rpc).toString("utf8"),
          );
          if (
            original?.binding?.jobId !== job.id ||
            original.binding.rpcId !== entry.physical.turnId ||
            !isDeepStrictEqual(original.binding.physicalTurn, entry.physical)
          )
            throw Error("Physical turn differs from original RPC");
          if (job.request.kind === "command" && entry.target) {
            const scope = original.binding.documentScope;
            if (scope?.producer !== "compiled-cad-v1" ||
                !["param.inspect","param.apply"].includes(scope.operation) ||
                typeof scope.sourceHash !== "string" ||
                !/^[a-f0-9]{64}$/.test(scope.sourceHash) ||
                scope.wireSourceHash !== original.binding.sourceHash ||
                scope.buildHash !== original.binding.buildHash ||
                !isDeepStrictEqual(scope.target,entry.target))
              throw Error("Original document scope lacks its compiler/source binding");
          }
        } else {
          const file = path.join(directory,"physical-reads",
            createHash("sha256").update(entry.physical.turnId).digest("hex")+".json");
          const original = JSON.parse(readBytes(file,MAX_JSON_RECORD_BYTES,fs,file).toString("utf8"));
          if (original?.version !== 1 ||
              !isDeepStrictEqual(original.request,entry.request) ||
              !isDeepStrictEqual(original.physicalTurn,entry.physical))
            throw Error("Physical read differs from its original intent");
        }
      }
    }
  } catch (cause) {
    throw Object.assign(
      new Error("Original physical catalog unavailable or changed", { cause }),
      { code: "CORRUPT_STATE" },
    );
  }
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
    if (snapshot)
      assertPhysicalCatalog(snapshot, options.physicalCatalogDirectory ?? dir);
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
