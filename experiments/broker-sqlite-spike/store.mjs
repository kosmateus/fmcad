import { randomUUID } from "node:crypto";
import { open } from "./sqlite.mjs";
import { canonical, fail, hash } from "./wire.mjs";
import { validateHistoryCopy } from "./history.mjs";

export function store(path, afterInsert) {
  const { sql, write, settings, transactions } = open(
    path,
    `
    CREATE TABLE IF NOT EXISTS broker (
      id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO broker VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS jobs (
      ordinal INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL,
      request_id TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, hash TEXT NOT NULL,
      input TEXT NOT NULL, state TEXT NOT NULL CHECK (
        state IN ('accepted','preparing','ready','running','UNKNOWN','succeeded','not_started')
      ),
      holds_turn INTEGER NOT NULL DEFAULT 0 CHECK (holds_turn IN (0,1)),
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
      prepared_hash TEXT, call TEXT, receipts TEXT NOT NULL DEFAULT '{}', historical BLOB,
      CHECK (holds_turn = 0 OR (state IN ('running','UNKNOWN') AND (call IS NOT NULL OR historical IS NOT NULL)))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS work_by_state ON jobs(state, ordinal);
    CREATE UNIQUE INDEX IF NOT EXISTS one_turn ON jobs((1)) WHERE holds_turn = 1;
  `,
  );
  const active = () => sql("SELECT * FROM jobs WHERE holds_turn = 1").get();
  const byRequest = (requestId) =>
    sql("SELECT * FROM jobs WHERE request_id = ?").get(requestId);
  const owned = (owner, requestId) => {
    const row = byRequest(requestId);
    if (!row || row.owner !== owner) fail("NOT_FOUND");
    return row;
  };
  const insert =
    sql(`INSERT INTO jobs(id, request_id, owner, hash, input, state, historical)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const boot = write("boot", () => {
    sql(
      "UPDATE jobs SET state = 'accepted' WHERE state IN ('preparing','ready')",
    ).run();
    sql("UPDATE jobs SET state = 'UNKNOWN' WHERE state = 'running'").run();
    return sql("UPDATE broker SET epoch = epoch + 1 RETURNING epoch")
      .pluck()
      .get();
  });
  const admit = write("admit", (owner, request) => {
    const { description, ...input } = request;
    const digest = hash({ ...input, clientId: owner });
    const row = byRequest(input.requestId);
    if (row) {
      if (row.historical || row.owner !== owner || row.hash !== digest)
        fail("REQUEST_CONFLICT");
      return row;
    }
    insert.run(
      randomUUID(),
      input.requestId,
      owner,
      digest,
      canonical(input),
      "accepted",
      null,
    );
    afterInsert(input);
    return byRequest(input.requestId);
  });
  const beginPreparation = write("beginPreparation", () =>
    sql(`
    UPDATE jobs SET state = 'preparing'
    WHERE ordinal = (SELECT ordinal FROM jobs WHERE state = 'accepted' ORDER BY ordinal LIMIT 1)
    RETURNING *
  `).get(),
  );
  const prepared = write("prepared", (id, digest) =>
    sql(
      "UPDATE jobs SET state = 'ready', prepared_hash = ? WHERE id = ? AND state = 'preparing'",
    ).run(digest, id),
  );
  const claim = write("claim", (makeCall) => {
    if (active()) return;
    const row = sql(
      "SELECT * FROM jobs WHERE state = 'ready' ORDER BY ordinal LIMIT 1",
    ).get();
    if (!row) return;
    const call = makeCall(row, "main");
    sql(
      "UPDATE jobs SET state = 'running', holds_turn = 1, call = ? WHERE id = ?",
    ).run(canonical(call), row.id);
    return call;
  });
  const cancel = write("cancel", (owner, requestId) => {
    const row = owned(owner, requestId);
    if (row.historical) return row;
    if (["accepted", "preparing", "ready"].includes(row.state)) {
      sql(
        "UPDATE jobs SET state = 'not_started', cancel_requested = 1 WHERE id = ?",
      ).run(row.id);
    } else if (row.holds_turn) {
      sql("UPDATE jobs SET cancel_requested = 1 WHERE id = ?").run(row.id);
    }
    return owned(owner, requestId);
  });
  const unknown = write("unknown", (call) =>
    sql(
      "UPDATE jobs SET state = 'UNKNOWN' WHERE holds_turn = 1 AND call = ?",
    ).run(canonical(call)),
  );
  const record = write(
    "record",
    (call, receipt, nextCall, missingPostflight = false) => {
      if (
        !receipt ||
        canonical(receipt.call) !== canonical(call) ||
        !["complete", "not_started"].includes(receipt.outcome) ||
        (receipt.outcome === "complete" &&
          receipt.marker !== `${call.id}:effect`) ||
        (receipt.outcome === "not_started" && call.phase !== "main")
      )
        fail("UNBOUND_RECEIPT");
      const row = active();
      if (!row || row.call !== canonical(call)) return false;
      const receipts = JSON.stringify({
        ...JSON.parse(row.receipts),
        [call.phase]: receipt,
      });
      const holdsTurn = nextCall || missingPostflight ? 1 : 0;
      const state = nextCall
        ? "running"
        : missingPostflight
          ? "UNKNOWN"
          : receipt.outcome === "complete"
            ? "succeeded"
            : "not_started";
      sql(
        "UPDATE jobs SET state = ?, holds_turn = ?, call = ?, receipts = ? WHERE id = ?",
      ).run(state, holdsTurn, canonical(nextCall ?? call), receipts, row.id);
      return true;
    },
  );
  const importCopy = write("importCopy", (bytes) => {
    const job = validateHistoryCopy(bytes);
    const previous = byRequest(job.requestId);
    if (previous?.historical && Buffer.from(previous.historical).equals(bytes))
      return previous;
    if (previous) fail("REQUEST_CONFLICT");
    if (
      sql(
        "SELECT 1 FROM jobs WHERE state IN ('accepted','preparing','ready') OR holds_turn = 1",
      ).get()
    ) {
      fail("QUEUE_NOT_IDLE");
    }
    insert.run(
      job.id,
      job.requestId,
      job.clientId,
      job.hash,
      canonical(job.request),
      "UNKNOWN",
      bytes,
    );
    sql("UPDATE jobs SET holds_turn = 1 WHERE id = ?").run(job.id);
    return byRequest(job.requestId);
  });

  return {
    settings,
    transactions,
    boot,
    admit,
    owned,
    active,
    beginPreparation,
    prepared,
    claim,
    cancel,
    unknown,
    record,
    importCopy,
  };
}

export function view(row) {
  return {
    id: row.id,
    owner: row.owner,
    requestId: row.request_id,
    hash: row.hash,
    state: row.state,
    holdsTurn: Boolean(row.holds_turn),
    cancelRequested: Boolean(row.cancel_requested),
    receipts: JSON.parse(row.receipts),
    ...(row.historical && { historical: true }),
  };
}
