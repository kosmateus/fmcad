import type {
  QueueIsolationTarget,
  QueueJob,
  QueueQuarantine,
  QueueRequest,
  QueueSnapshot,
  QueuePhysicalBinding,
  QueuePhysicalDispatch,
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
  // Only the fixed document-constrained command service establishes this scope.
  // An arbitrary run script or a global command never becomes scoped by flags.
  const argv =
    request.argv?.[0] === "cad" ? request.argv.slice(1) : request.argv;
  if (!argv || argv[0] !== "param" || !["inspect", "apply"].includes(argv[1]!)) return null;
  const target: QueueIsolationTarget = {};
  const flags = new Set<string>();
  for (let index = 2; index < argv.length; index += 2) {
    const flag = argv[index]!,
      value = argv[index + 1];
    if (
      !["--doc", "--doc-id", "--doc-file-id"].includes(flag) ||
      flags.has(flag) ||
      !value?.trim() ||
      value.startsWith("--")
    )
      return null;
    flags.add(flag);
    if (flag === "--doc-id") target.creationId = value;
    if (flag === "--doc-file-id") target.fileId = value;
  }
  return Object.keys(target).length ? target : null;
}
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
export function physicalBinding(value: unknown): value is QueuePhysicalBinding {
  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !==
      "generation,grantDigest,physicalRuntime,target,turnId,version" ||
    value["version"] !== 1 ||
    !digest(value["grantDigest"]) ||
    !text(value["target"]) ||
    !text(value["turnId"]) ||
    !/^[!-~]{1,256}$/.test(value["turnId"])
  )
    return false;
  const generation = value["generation"],
    runtime = value["physicalRuntime"];
  return (
    record(generation) &&
    Object.keys(generation).sort().join(",") === "epoch,instance" &&
    text(generation["epoch"]) &&
    text(generation["instance"]) &&
    record(runtime) &&
    Object.keys(runtime).sort().join(",") ===
      "birth,build,pid,source,version" &&
    typeof runtime["pid"] === "number" &&
    Number.isSafeInteger(runtime["pid"]) &&
    runtime["pid"] > 0 &&
    ["birth", "build", "source", "version"].every((key) => text(runtime[key]))
  );
}
/** Exact fork AdmissionStore._encode checksum input, not job settlement. */
export function physicalReleaseInput(
  binding: QueuePhysicalBinding,
  releasedBy: string,
): string {
  const runtime = binding.physicalRuntime;
  return JSON.stringify({
    binding: {
      generation: {
        epoch: binding.generation.epoch,
        instance: binding.generation.instance,
      },
      grantDigest: binding.grantDigest,
      physicalRuntime: {
        birth: runtime.birth,
        build: runtime.build,
        pid: runtime.pid,
        source: runtime.source,
        version: runtime.version,
      },
      target: binding.target,
      turnId: binding.turnId,
      version: binding.version,
    },
    releasedBy,
    state: "released",
  }).replace(
    /[\u007f-\uffff]/g,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
export function validPhysicalDispatch(
  job: QueueJob,
  entry: QueuePhysicalDispatch,
): boolean {
  if (
    !entry ||
    !record(entry.request) ||
    !physicalBinding(entry.physical) ||
    entry.request.jobId !== job.id ||
    entry.request.physicalRequestId !== entry.physical.turnId ||
    !text(entry.request.requestId) ||
    !text(entry.request.clientId) ||
    !text(entry.request.requestHash) ||
    !Number.isSafeInteger(entry.request.grantGeneration) ||
    entry.request.grantGeneration < 0 ||
    !/^physical-turn-[a-f0-9]{64}\.json$/.test(entry.intentReference) ||
    !digest(entry.intentDigest)
  )
    return false;
  if (entry.request.kind === "product") {
    if (
      entry.request.requestId !== job.requestId ||
      entry.request.clientId !== job.clientId ||
      entry.request.requestHash !== job.hash
    )
      return false;
  } else if (entry.request.kind !== "system-read") return false;
  try {
    const selector = JSON.parse(entry.physical.target);
    const expected = entry.request.documentSelector ?? null;
    return (
      JSON.stringify(selector, selector && Object.keys(selector).sort()) ===
      JSON.stringify(expected, expected && Object.keys(expected).sort())
    );
  } catch {
    return false;
  }
}
export function validRelease(
  proof: unknown,
  binding: QueuePhysicalBinding,
  hash: (text: string) => string,
): boolean {
  if (
    !record(proof) ||
    Object.keys(proof).sort().join(",") !==
      "binding,evidenceDigest,physicalEvidenceReference,state" ||
    proof["state"] !== "released" ||
    !physicalBinding(proof["binding"]) ||
    physicalReleaseInput(proof["binding"], "dispatch-finally") !==
      physicalReleaseInput(binding, "dispatch-finally") ||
    !digest(proof["evidenceDigest"]) ||
    proof["physicalEvidenceReference"] !==
      "fmcad-physical-turn:sha256:" + proof["evidenceDigest"]
  )
    return false;
  return ["dispatch-finally", "cancelled-before-sdk"].some(
    (reason) =>
      hash(physicalReleaseInput(binding, reason)) === proof["evidenceDigest"],
  );
}

export function validQuarantine(
  job: QueueJob,
  record: QueueQuarantine,
  hash: (text: string) => string,
): boolean {
  if (!record || typeof record !== "object") return false;
  const catalog = job.physicalDispatches,
    proofs = record.binding?.["physicalTurns"];
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
    record.binding["clientId"] === job.clientId &&
    Array.isArray(catalog) &&
    catalog.length > 0 &&
    catalog.every((entry) => validPhysicalDispatch(job, entry)) &&
    new Set(catalog.map((entry) => entry.physical.turnId)).size ===
      catalog.length &&
    new Set(catalog.map((entry) => entry.intentReference)).size ===
      catalog.length &&
    catalog.filter((entry) => entry.request.kind === "product").length >=
      (job.dispatch?.rpcCount ?? 0) &&
    record.catalogDigest === hash(JSON.stringify(catalog)) &&
    Array.isArray(proofs) &&
    proofs.length === catalog.length &&
    catalog.every((entry, index) =>
      validRelease(proofs[index], entry.physical, hash),
    ) &&
    proofs[0]?.evidenceDigest === record.evidenceDigest
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
