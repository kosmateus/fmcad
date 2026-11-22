import type {
  QueueIsolationTarget,
  QueueJob,
  QueueQuarantine,
  QueueRequest,
  QueueSnapshot,
} from "./queue-model";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Only exact document/DataFile IDs establish independence. Names, raw scripts
 * and unpinned or incomparable aliases remain conservatively conflicting. */
export function quarantineTarget(
  request: QueueRequest,
): QueueIsolationTarget | null {
  if (request.kind === "rpc") {
    const params = request.payload?.["params"];
    if (!record(params)) return null;
    const { name, arguments: args } = params;
    if (
      request.payload?.["method"] !== "tools/call" ||
      name !== "get_open_document_metadata" ||
      !record(args)
    )
      return null;
    const { fileId, version } = args;
    return typeof fileId === "string" &&
      fileId.trim() &&
      typeof version === "number" &&
      Number.isSafeInteger(version) &&
      version > 0
      ? { fileId }
      : null;
  }
  let argv = request.argv;
  if (!argv) return null;
  const separator = argv.indexOf("--");
  if (separator >= 0) argv = argv.slice(0, separator);
  const target: QueueIsolationTarget = {};
  for (const [flag, key] of [
    ["--doc-id", "creationId"],
    ["--doc-file-id", "fileId"],
  ] as const) {
    const index = argv.indexOf(flag);
    if (index < 0) continue;
    const value = argv[index + 1];
    if (
      argv.filter((item) => item === flag).length !== 1 ||
      !value ||
      value.startsWith("--")
    )
      return null;
    target[key] = value;
  }
  return Object.keys(target).length ? target : null;
}

export function validQuarantine(
  job: QueueJob,
  record: QueueQuarantine,
): boolean {
  if (!record || typeof record !== "object") return false;
  return (
    job.state === "needs_reconciliation" &&
    record.jobId === job.id &&
    record.requestId === job.requestId &&
    record.clientId === job.clientId &&
    record.jobHash === job.hash &&
    JSON.stringify(record.target) ===
      JSON.stringify(quarantineTarget(job.request)) &&
    record.evidenceReference ===
      "fmcad-physical-turn:sha256:" + record.evidenceDigest &&
    typeof record.evidenceDigest === "string" &&
    /^[a-f0-9]{64}$/.test(record.evidenceDigest) &&
    !!record.binding &&
    typeof record.binding === "object" &&
    record.binding["jobId"] === job.id &&
    record.binding["requestId"] === job.requestId &&
    record.binding["requestHash"] === job.hash &&
    record.binding["clientId"] === job.clientId
  );
}

export function conflictsWithQuarantine(
  snapshot: QueueSnapshot,
  request: QueueRequest,
): boolean {
  const target = quarantineTarget(request);
  return Object.values(snapshot.quarantined ?? {}).some((record) => {
    if (!target || !record.target) return true;
    if (
      record.target.creationId &&
      record.target.creationId === target.creationId
    )
      return true;
    if (record.target.fileId && target.fileId)
      return record.target.fileId === target.fileId;
    if (record.target.fileId || target.fileId) return true; // No proof that an ID/name alias is another DataFile.
    return !record.target.creationId || !target.creationId;
  });
}
