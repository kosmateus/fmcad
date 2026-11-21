import { appendFileSync } from "node:fs";
import { canonical, fail } from "./wire.mjs";
import { open } from "./sqlite.mjs";

// This is the independent fake receiver/SDK boundary, never a broker store reader.
export function receiver(config, gate, notify) {
  const { sql, write, settings, transactions } = open(
    config.database,
    `
    CREATE TABLE IF NOT EXISTS fence (
      id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL
    ) STRICT;
    INSERT OR IGNORE INTO fence VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS calls (
      id TEXT PRIMARY KEY, binding TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('withdrawn','active','complete')),
      receipt TEXT
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_effect ON calls((1)) WHERE state = 'active';
  `,
  );
  const get = (id) => sql("SELECT * FROM calls WHERE id = ?").get(id);
  function matching(call) {
    const row = get(call.id);
    if (row && row.binding !== canonical(call)) fail("CALL_CONFLICT");
    return row;
  }
  const evidence = (row) =>
    row && { state: row.state, receipt: JSON.parse(row.receipt) };
  const fence = write("fence", (epoch) => {
    if (!Number.isSafeInteger(epoch) || epoch < 1) fail("INVALID_EPOCH");
    const current = sql("SELECT epoch FROM fence").pluck().get();
    if (epoch < current) fail("STALE_EPOCH");
    sql("UPDATE fence SET epoch = ?").run(epoch);
    return epoch;
  });
  const withdraw = write("withdraw", (call) => {
    if (call.epoch > sql("SELECT epoch FROM fence").pluck().get())
      fail("INVALID_EPOCH");
    const existing = matching(call);
    if (existing) return evidence(existing);
    const receipt = { call, outcome: "not_started" };
    sql("INSERT INTO calls VALUES (?, ?, 'withdrawn', ?)").run(
      call.id,
      canonical(call),
      JSON.stringify(receipt),
    );
    return { state: "withdrawn", receipt };
  });
  const admit = write("admit", (call) => {
    if (call.epoch !== sql("SELECT epoch FROM fence").pluck().get())
      fail("STALE_EPOCH");
    const existing = matching(call);
    if (existing) return { existing: evidence(existing) };
    if (sql("SELECT 1 FROM calls WHERE state = 'active'").get())
      fail("PHYSICAL_BUSY");
    sql("INSERT INTO calls VALUES (?, ?, 'active', NULL)").run(
      call.id,
      canonical(call),
    );
    return {};
  });
  const finish = write("finish", (call) => {
    const receipt = { call, outcome: "complete", marker: `${call.id}:effect` };
    const change = sql(
      "UPDATE calls SET state = 'complete', receipt = ? WHERE id = ? AND binding = ? AND state = 'active'",
    ).run(JSON.stringify(receipt), call.id, canonical(call));
    if (change.changes !== 1) fail("UNBOUND_RECEIPT");
    return { state: "complete", receipt };
  });

  return async ({ op, secret, call, epoch }) => {
    // The process-crash witness counts wire arrivals, not merely accepted/effectful calls.
    if (op === "dispatch")
      appendFileSync(config.attempts, `${JSON.stringify(call ?? null)}\n`, {
        flush: true,
      });
    if (op === "fence" || op === "metrics") {
      if (secret !== config.admin) fail("UNAUTHORIZED");
      return op === "fence" ? fence(epoch) : { settings, transactions };
    }
    if (secret !== config.dispatch) fail("UNAUTHORIZED");
    if (
      !call ||
      call.instance !== config.instance ||
      call.build !== config.build ||
      call.source !== config.source ||
      call.id !== `${call.jobId}:${call.phase}` ||
      !["main", "postflight"].includes(call.phase)
    )
      fail("UNBOUND_CALL");
    if (op === "lookup") return evidence(matching(call)) ?? null;
    if (op === "withdraw") {
      const proof = withdraw(call);
      await gate("before-withdraw-reply", call);
      return proof;
    }
    if (op !== "dispatch") fail("INVALID_OPERATION");
    const { existing } = admit(call);
    if (existing) return existing;
    notify("physical-start", call);
    await gate("before-effect", call);
    // Intentionally outside either SQLite transaction, analogous to an SDK/file effect.
    appendFileSync(config.effects, `${JSON.stringify(call)}\n`, {
      flush: true,
    });
    await gate("after-effect", call);
    const result = finish(call);
    notify("physical-end", call);
    await gate("before-receiver-reply", call);
    return result;
  };
}
