import path from "node:path";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import type { QueueDomainOptions, QueueSnapshot } from "@fmcad/core";
const load = createRequire(__filename);
const { QueueDomain, terminal, validateQueueOptions, canonical } = load(
  "./dist/core/domain/queue",
) as typeof import("../packages/core/src/domain/queue");
const { createSnapshotStore, readBytes, MAX_JSON_RECORD_BYTES } = load(
  "./dist/node-adapters/persistence/records",
) as typeof import("../packages/node-adapters/src/persistence/records");
const { validPhysicalDispatch } = load("./dist/core/domain/queue-quarantine") as
  typeof import("../packages/core/src/domain/queue-quarantine");
const { createRuntimeRetirementAuthority, projectRuntimeRetirement, verifiedRuntimeRetirement } = load(
  "./dist/core/domain/runtime-retirement",
) as typeof import("../packages/core/src/domain/runtime-retirement");
const { decodeOpaqueQueueJson } = load(
  "./dist/node-adapters/execution/admission-json",
) as { decodeOpaqueQueueJson(text: string): unknown };
export { terminal };
/** Composition-only factory. Use the SAME staged core module as QueueDomain;
 * private WeakMap membership must never be recreated from serialized markers. */
export const createQueueRuntimeRetirementAuthority = createRuntimeRetirementAuthority;
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
      const entries = job.physicalDispatches ?? [];
      if (job.physicalDispatchCount === undefined &&
          entries.some(entry=>entry.catalogIndex !== undefined))
        throw Error("Indexed physical catalog lost its admission counter");
      if (job.physicalDispatchCount !== undefined &&
          (!Number.isSafeInteger(job.physicalDispatchCount) ||
           job.physicalDispatchCount !== entries.length))
        throw Error("Physical catalog lost an admitted turn");
      if (!entries.length && snapshot.quarantined?.[job.id])
        throw Error("Missing physical catalog");
      if (path.basename(job.id) !== job.id)
        throw Error("Foreign physical catalog");
      const root = path.join(directory, "jobs", job.id);
      const files = (fs.existsSync(root) ? fs.readdirSync(root) : [])
        .filter((name) => /^physical-turn-[a-f0-9]{64}\.json$/.test(name));
      if (entries.some(entry => !files.includes(entry.intentReference)))
        throw Error("Physical catalog is incomplete");
      for (const name of files) {
        const file = path.join(root,name);
        const bytes = readBytes(file, MAX_JSON_RECORD_BYTES, fs, file);
        const body = JSON.parse(bytes.toString("utf8"));
        const digest = createHash("sha256").update(bytes).digest("hex");
        const committed = entries.find(entry=>entry.intentReference===name);
        const entry = committed ?? {...body,intentReference:name,intentDigest:digest};
        if (!validPhysicalDispatch(job,entry))
          throw Error("Invalid original physical intent");
        if (!committed && (!Number.isSafeInteger(entry.catalogIndex) ||
            entry.catalogIndex <= (job.physicalDispatchCount ?? entries.length)))
          throw Error("Physical intent lacks proof of uncommitted preparation");
        if (typeof entry.physical?.turnId !== "string" ||
            !/^[A-Za-z0-9_-]{1,256}$/.test(entry.physical.turnId))
          throw Error("Foreign original RPC path");
        if (
          digest !== entry.intentDigest ||
          !isDeepStrictEqual(body, {
            request: entry.request,
            physical: entry.physical,
            target: entry.target,
            ...(entry.catalogIndex === undefined ? {} : {catalogIndex:entry.catalogIndex}),
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
          if (entry.catalogIndex !== undefined &&
              original.physicalCatalogIndex !== entry.catalogIndex)
            throw Error("Original RPC catalog admission index changed");
          // Catalog admission and rpcCount are one atomic snapshot commit.
          // A prepared original with a later index never crossed that boundary
          // and therefore could not reach send. Do not invent a native proof.
          if (!committed && (!Number.isSafeInteger(original.dispatchIndex) ||
              original.dispatchIndex <= (job.dispatch?.rpcCount ?? 0)))
            throw Error("Dispatched physical intent is missing from its catalog");
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
              !isDeepStrictEqual(original.physicalTurn,entry.physical) ||
              original.catalogIndex !== entry.catalogIndex)
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
        snapshot = (options.runtimeRetirement
          ? decodeOpaqueQueueJson(serialized)
          : JSON.parse(serialized)) as QueueSnapshot;
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
    if (snapshot && options.runtimeRetirement && options.recover !== false) {
      const verifyBytes = () => {
        const verified = verifiedRuntimeRetirement(options.runtimeRetirement);
        if (serialized === null ||
          createHash("sha256").update(serialized).digest("hex") !== verified.currentSnapshotDigest)
          throw Object.assign(
            new Error("Approved runtime view differs from the exact current queue bytes"),
            { code: "RUNTIME_RETIREMENT_CHANGED" },
          );
      };
      verifyBytes();
      const projected = projectRuntimeRetirement(
        snapshot, options.runtimeRetirement,
        canonical,
        (text) => createHash("sha256").update(text).digest("hex"),
        now(),
      );
      const next = JSON.stringify(projected);
      if (next !== serialized) {
        if (store.restore() !== serialized)
          throw Object.assign(
            new Error("Queue bytes changed before runtime retirement projection"),
            { code: "RUNTIME_RETIREMENT_CHANGED" },
          );
        // Re-check the live private authority at the write boundary. Its adapter
        // must assert the actual writer claim and exact approved current bytes.
        verifyBytes();
        store.commit(next);
        serialized = next;
      }
      snapshot = projected;
    }
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
