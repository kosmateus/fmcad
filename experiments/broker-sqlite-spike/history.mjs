import { fail, hash } from "./wire.mjs";

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value) =>
  typeof value === "string" && value.trim() !== "" && value.length <= 256;

// The spike supports the single blocked RPC case, not arbitrary snapshots or receipt formats.
export function validateHistoryCopy(bytes) {
  let copy;
  try {
    copy = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      (_, value) => {
        if (typeof value === "number" && !Number.isFinite(value))
          fail("INVALID_HISTORY");
        return value;
      },
    );
  } catch {
    fail("INVALID_HISTORY");
  }
  const { snapshot, receipts } = copy ?? {};
  if (
    snapshot?.version !== 1 ||
    snapshot.lease !== null ||
    snapshot.localUnknown != null ||
    !id(snapshot.active) ||
    !isObject(snapshot.jobs) ||
    Object.keys(snapshot.jobs).length !== 1 ||
    !Object.hasOwn(snapshot.jobs, snapshot.active) ||
    !Array.isArray(receipts)
  )
    fail("INVALID_HISTORY");

  const job = snapshot.jobs[snapshot.active];
  if (
    !isObject(job) ||
    job.id !== snapshot.active ||
    job.id !== snapshot.blocked?.id ||
    job.state !== "needs_reconciliation" ||
    job.kind !== "rpc" ||
    job.sequenceId !== null ||
    !id(job.requestId) ||
    !id(job.clientId) ||
    !isObject(job.request) ||
    typeof job.hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(job.hash)
  )
    fail("INVALID_HISTORY");

  const { description, ...request } = job.request;
  if (
    request.requestId !== job.requestId ||
    request.clientId !== job.clientId ||
    request.kind !== job.kind ||
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    !isObject(request.payload) ||
    hash(request) !== job.hash
  )
    fail("INVALID_HISTORY");

  const receiptIds = new Set();
  const rpcIds = new Set();
  for (const receipt of receipts) {
    if (
      !isObject(receipt) ||
      receipt.owner !== job.clientId ||
      receipt.jobId !== job.id ||
      receipt.requestId !== job.requestId ||
      receipt.hash !== job.hash ||
      receipt.outcome !== "complete" ||
      ![
        receipt.receiptId,
        receipt.rpcId,
        receipt.build,
        receipt.source,
        receipt.instance,
      ].every(id) ||
      receiptIds.has(receipt.receiptId) ||
      rpcIds.has(receipt.rpcId)
    )
      fail("INVALID_HISTORY");
    receiptIds.add(receipt.receiptId);
    rpcIds.add(receipt.rpcId);
  }
  return job;
}
