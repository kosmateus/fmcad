import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { QueueJob, QueueSnapshot } from "@fmcad/core";
import type { ApprovedRuntimeRebaselineRoot } from "./queue-runtime-rebaseline";
import type {
  RuntimeRetiredExposure,
  VerifiedRuntimeRetirement,
} from "../packages/core/src/domain/runtime-retirement";
import { createQueueRuntimeRetirementAuthority } from "./queue-state";

const load = createRequire(__filename);
const { canonical } = load(
  "./dist/core/domain/queue",
) as typeof import("../packages/core/src/domain/queue");
const { decodeOpaqueQueueJson } = load(
  "./dist/node-adapters/execution/admission-json",
) as typeof import("../packages/node-adapters/src/execution/admission-json");
const { readBytes } = load(
  "./dist/node-adapters/persistence/records",
) as typeof import("../packages/node-adapters/src/persistence/records");
const sha = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
// Match the existing snapshot store's bound, not the smaller RPC-record bound.
const MAX_QUEUE_SNAPSHOT_BYTES = 128 * 1024 * 1024;
type ProjectionRoot = Omit<
  ApprovedRuntimeRebaselineRoot,
  "snapshot" | "snapshots" | "currentFiles"
> & {
  frozenBaseline: Pick<ApprovedRuntimeRebaselineRoot, "snapshot" | "snapshots">;
  currentFiles: Readonly<Record<string, Buffer | null>>;
};
function refused(message: string): never {
  throw Object.assign(new Error(message), {
    code: "RUNTIME_RETIREMENT_CHANGED",
  });
}

/** Private composition adapter. The caller supplies the actual approved native
 * root and live ownership/root assertions, never JSON from a public request. */
export function createApprovedRuntimeRetirement(options: {
  root: ProjectionRoot;
  assertVerifiedRoot(directory: string): void;
  assertBrokerOwner(): void;
}) {
  const root = options.root;
  const currentFiles = Object.fromEntries(
    Object.entries(root.currentFiles).map(([name, bytes]) => [
      name,
      bytes === null ? null : Buffer.from(bytes),
    ]),
  );
  const directory = root.record.store;
  const baseline = JSON.parse(
    JSON.stringify(root.frozenBaseline),
  ) as ProjectionRoot["frozenBaseline"];
  const record = JSON.parse(
    JSON.stringify(root.record),
  ) as ProjectionRoot["record"];
  const recordDigest = sha(JSON.stringify(record));
  if (
    typeof record.request.requestId !== "string" ||
    !record.request.requestId ||
    record.request.requestId.includes("/") ||
    record.request.requestId.includes("\\") ||
    record.request.requestId === "." ||
    record.request.requestId === ".."
  )
    refused("Invalid authenticated runtime root record location");
  const recordFile = path.join(
    directory,
    "runtime-rebaselines",
    record.request.requestId,
    "record.json",
  );
  function assertRoot() {
    options.assertBrokerOwner();
    options.assertVerifiedRoot(directory);
    if (fs.realpathSync(directory) !== directory)
      refused("Runtime retirement store is not canonical");
    const stat = fs.statSync(directory);
    if (stat.dev !== record.storeDevice || stat.ino !== record.storeInode)
      refused("Runtime retirement store identity changed");
    if (
      sha(readBytes(recordFile, 128 * 1024 * 1024, fs, recordFile)) !==
      recordDigest
    )
      refused(
        "Projection root differs from the authenticated immutable record",
      );
    const headFile = path.join(directory, "runtime-rebaseline-head.json");
    const expectedHead = Buffer.from(
      JSON.stringify({
        version: 1,
        newHead: record.receipt.newHead,
        record: { path: recordFile, sha256: recordDigest },
      }),
    );
    if (!readBytes(headFile, 1024 * 1024, fs, headFile).equals(expectedHead))
      refused("Projection root differs from the current authenticated head");
  }
  assertRoot();
  for (const layer of Object.keys(record.layers)) {
    const fileKey =
      layer === "root" ? "queue-state.json" : layer + "/queue-state.json";
    const reference = record.frozen[fileKey];
    if (!reference)
      refused("Runtime layer has no immutable snapshot reference");
    const bytes = readBytes(
      reference.path,
      MAX_QUEUE_SNAPSHOT_BYTES,
      fs,
      reference.path,
    );
    if (sha(bytes) !== reference.sha256)
      refused("Immutable runtime baseline bytes changed");
    const decoded = decodeOpaqueQueueJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (canonical(decoded) !== canonical(baseline.snapshots[layer]))
      refused("Provided frozen baseline differs from the authenticated bytes");
  }
  const exposures: Record<string, RuntimeRetiredExposure> = {};
  for (const [layer, layerRecord] of Object.entries(record.layers)) {
    const snapshot = baseline.snapshots[layer] as unknown as
      QueueSnapshot | undefined;
    if (!snapshot)
      refused("Runtime retirement layer has no immutable baseline");
    for (const [jobId, decision] of Object.entries(layerRecord.dispositions)) {
      if (decision.outcome !== "unknown") continue;
      const job = snapshot.jobs[jobId];
      if (!job) refused("Runtime retirement job is missing from its baseline");
      const key = "runtime-job:" + sha(canonical([layer, jobId]));
      exposures[key] = {
        kind: "runtime_retired",
        key,
        layer,
        rootHead: record.receipt.newHead,
        recordDigest,
        entryDigest: sha(canonical(job)),
        target: null,
        source: {
          kind: "job",
          jobId,
          requestId: job.requestId,
          clientId: job.clientId,
          jobHash: job.hash,
          catalogDigest: sha(
            canonical(job.physicalDispatches ?? job.dispatch ?? null),
          ),
        },
      };
    }
    for (const [field, kind] of [
      ["localUnknown", "local"],
      ["controlBlocked", "control"],
    ] as const) {
      const value = snapshot[field];
      if (value === undefined) continue;
      const key = "runtime-local:" + sha(canonical([layer, field]));
      exposures[key] = {
        kind: "runtime_retired",
        key,
        layer,
        rootHead: record.receipt.newHead,
        recordDigest,
        entryDigest: sha(canonical(value)),
        target: null,
        source: { kind, valueDigest: sha(canonical(value)) },
      };
    }
  }
  return Object.freeze({
    forDirectory(queueDirectory: string) {
      assertRoot();
      if (fs.realpathSync(queueDirectory) !== queueDirectory)
        refused("Queue layer is not canonical");
      const relative = path.relative(directory, queueDirectory);
      if (
        relative === ".." ||
        relative.startsWith(".." + path.sep) ||
        path.isAbsolute(relative)
      )
        refused("Queue layer escaped the approved runtime store");
      const layer = relative ? relative.split(path.sep).join("/") : "root";
      const fileKey = relative
        ? layer + "/queue-state.json"
        : "queue-state.json";
      const layerRecord = record.layers[layer];
      const frozen = baseline.snapshots[layer] as unknown as
        QueueSnapshot | undefined;
      const reference = record.frozen[fileKey];
      const approvedBytes = currentFiles[fileKey];
      if (!layerRecord || !frozen || !reference || !approvedBytes)
        refused("Queue layer is absent from the authenticated runtime root");
      const marker = {
        rootHead: record.receipt.newHead,
        recordDigest,
        layer,
        frozenDigest: reference.sha256,
      };
      const jobs: VerifiedRuntimeRetirement["jobs"] = Object.fromEntries(
        Object.entries(layerRecord.dispositions).map(([id, decision]) => {
          const original: QueueJob | undefined = frozen.jobs[id];
          if (!original) refused("Runtime disposition has no original job");
          return [id, { original, outcome: decision.outcome }];
        }),
      );
      const file = path.join(queueDirectory, "queue-state.json");
      const initial = Buffer.from(approvedBytes);
      const initialBytes = readBytes(file, MAX_QUEUE_SNAPSHOT_BYTES, fs, file);
      if (!initialBytes.equals(initial))
        refused("Queue changed between native verification and writer claim");
      return createQueueRuntimeRetirementAuthority(() => {
        assertRoot();
        const bytes = readBytes(file, MAX_QUEUE_SNAPSHOT_BYTES, fs, file);
        const snapshot = decodeOpaqueQueueJson(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ) as unknown as QueueSnapshot;
        if (
          !bytes.equals(initial) &&
          (!snapshot.appliedRuntimeRetirement ||
            !snapshot.runtimeRetiredExposures ||
            canonical(snapshot.appliedRuntimeRetirement) !==
              canonical(marker) ||
            canonical(snapshot.runtimeRetiredExposures) !==
              canonical(exposures))
        )
          refused(
            "Unclassified queue evolution cannot inherit an old runtime retirement",
          );
        options.assertBrokerOwner();
        options.assertVerifiedRoot(directory);
        return {
          marker,
          currentSnapshotDigest: sha(bytes),
          frozen,
          jobs,
          exposures,
        };
      });
    },
  });
}
