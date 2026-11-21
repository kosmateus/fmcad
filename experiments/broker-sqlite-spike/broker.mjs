import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { ask, canonical, fail, hash } from "./wire.mjs";
import { store, view } from "./store.mjs";

export async function broker(config, gate, notify) {
  const db = store(config.database, (input) => {
    // Purposeful hard crash, not an exception rollback or a graceful shutdown.
    if (input.requestId === config.crashInsideAdmission)
      process.kill(process.pid, "SIGKILL");
  });
  const epoch = db.boot();
  const toReceiver = (op, call) =>
    ask(config.receiver, { op, secret: config.dispatch, call });
  await ask(config.receiver, { op: "fence", secret: config.admin, epoch });
  const loopDelay = monitorEventLoopDelay({ resolution: 1 });
  loopDelay.enable();
  let utilizationStart = performance.eventLoopUtilization();
  function metrics() {
    return {
      epoch,
      settings: db.settings,
      transactions: structuredClone(db.transactions),
      eventLoop: {
        samples: loopDelay.count,
        p99Ms: loopDelay.percentile(99) / 1e6,
        maxMs: loopDelay.max / 1e6,
        utilization:
          performance.eventLoopUtilization(utilizationStart).utilization,
      },
    };
  }
  const work = new Set();
  const makeCall = (row, phase) => ({
    id: `${row.id}:${phase}`,
    jobId: row.id,
    requestId: row.request_id,
    owner: row.owner,
    hash: row.hash,
    preparedHash: row.prepared_hash,
    phase,
    epoch,
    instance: config.instance,
    build: config.build,
    source: config.source,
  });
  const needsPostflight = (row) =>
    Boolean(JSON.parse(row.input).payload.postflight);
  // Settlement compares the full durable dispatch identity. Reconciliation is read-only at the
  // receiver and never creates a new physical call, including a missing postflight.
  async function reconcile(row) {
    if (!row?.call) return;
    const call = JSON.parse(row.call);
    let result;
    try {
      result = await toReceiver("lookup", call);
    } catch {
      return;
    }
    if (result?.receipt) {
      const missing =
        result.receipt.outcome === "complete" &&
        call.phase === "main" &&
        needsPostflight(row);
      db.record(call, result.receipt, undefined, missing);
    }
  }
  await reconcile(db.active());

  async function execute(first) {
    let call = first;
    try {
      await gate("before-dispatch", call);
      let result = await toReceiver("dispatch", call);
      if (!result?.receipt) return db.unknown(call);
      const row = db.active();
      if (
        row?.id === call.jobId &&
        result.receipt.outcome === "complete" &&
        needsPostflight(row)
      ) {
        const postflight = makeCall(row, "postflight");
        if (!db.record(call, result.receipt, postflight)) return;
        call = postflight;
        await gate("before-postflight", call);
        result = await toReceiver("dispatch", call);
        if (!result?.receipt) return db.unknown(call);
      }
      db.record(call, result.receipt);
    } catch {
      db.unknown(call);
    }
  }

  function runInBackground(promise) {
    promise.catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }
  function pump() {
    if (config.admissionOnly) return;
    for (let job; work.size < 2 && (job = db.beginPreparation());) {
      const { id, request_id: requestId } = job;
      work.add(id);
      runInBackground(
        (async () => {
          notify("prepare-start", { id, requestId });
          await gate("prepare", { id, requestId });
          const bytes = Buffer.from(canonical(JSON.parse(job.input).payload));
          const digest = Buffer.from(
            await crypto.subtle.digest("SHA-256", bytes),
          ).toString("hex");
          db.prepared(id, digest);
          work.delete(id);
          notify("prepare-end", { id, requestId });
          pump();
        })(),
      );
    }
    const call = db.claim(makeCall);
    if (call) runInBackground(execute(call).then(pump));
  }
  pump();
  return async ({ op, token, request, requestId, bytes }, signal) => {
    if (op === "metrics" || op === "reset-metrics" || op === "copy-history") {
      if (token !== config.admin) fail("UNAUTHORIZED");
      if (op === "copy-history") {
        if (typeof bytes !== "string") fail("INVALID_HISTORY");
        const row = db.importCopy(Buffer.from(bytes, "base64"));
        return {
          ...view(row),
          archivedBytes: Buffer.from(row.historical).toString("base64"),
        };
      }
      if (op === "reset-metrics") {
        utilizationStart = performance.eventLoopUtilization();
        loopDelay.reset();
      }
      return metrics();
    }
    const owner = Object.hasOwn(config.owners, token) && config.owners[token];
    if (!owner) fail("UNAUTHORIZED");
    if (op === "submit" || op === "recover-admission") {
      if (
        typeof request?.requestId !== "string" ||
        !request.requestId ||
        request.kind !== "rpc" ||
        !Number.isSafeInteger(request.timeoutMs) ||
        request.timeoutMs < 1 ||
        !request.payload ||
        typeof request.payload !== "object" ||
        Array.isArray(request.payload) ||
        Object.keys(request).some(
          (key) =>
            ![
              "requestId",
              "kind",
              "timeoutMs",
              "payload",
              "description",
            ].includes(key),
        )
      ) {
        fail("INVALID_REQUEST");
      }
      if (op === "recover-admission") {
        const row = db.owned(owner, request.requestId);
        const { description, ...input } = request;
        if (row.historical) fail("NOT_FOUND");
        if (row.hash !== hash({ ...input, clientId: owner }))
          fail("REQUEST_CONFLICT");
        return view(row);
      }
      await gate("before-admission-commit", request);
      const row = db.admit(owner, request);
      await gate("before-ack", row);
      // Schedule only after returning the admission reply, not as part of the commit.
      setImmediate(pump);
      return view(row);
    }
    if (op === "status") return view(db.owned(owner, requestId));
    if (op === "result") {
      while (!signal.aborted) {
        const row = db.owned(owner, requestId);
        if (["succeeded", "not_started", "UNKNOWN"].includes(row.state))
          return view(row);
        await sleep(10, undefined, { signal });
      }
      fail("WAIT_TIMEOUT");
    }
    if (op === "reconcile") {
      const row = db.owned(owner, requestId);
      // Do not move a live main phase into UNKNOWN while its dispatcher is still running.
      if (row.holds_turn && row.state === "UNKNOWN") await reconcile(row);
      pump();
      return view(db.owned(owner, requestId));
    }
    if (op === "cancel") {
      const row = db.cancel(owner, requestId);
      if (row.holds_turn && row.call) {
        const call = JSON.parse(row.call);
        if (call.phase === "main") {
          const proof = await toReceiver("withdraw", call);
          if (proof.state === "withdrawn") db.record(call, proof.receipt);
        }
      }
      pump();
      return view(db.owned(owner, requestId));
    }
    fail("INVALID_OPERATION");
  };
}
