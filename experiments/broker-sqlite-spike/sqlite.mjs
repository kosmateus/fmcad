import Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { fail } from "./wire.mjs";

export function open(path, schema) {
  const db = new Database(path, { timeout: 100 });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  const settings = {
    journal: db.pragma("journal_mode", { simple: true }),
    synchronous: db.pragma("synchronous", { simple: true }),
    busyTimeoutMs: db.pragma("busy_timeout", { simple: true }),
    engine: db.prepare("select sqlite_version() as version").get().version,
  };
  if (settings.journal !== "wal" || settings.synchronous !== 2)
    fail("UNSAFE_DURABILITY");
  db.exec(schema);

  const statements = new Map();
  const transactions = {};
  return {
    settings,
    transactions,
    sql(text) {
      if (!statements.has(text)) statements.set(text, db.prepare(text));
      return statements.get(text);
    },
    write(name, action) {
      const tx = db.transaction(action);
      return (...args) => {
        const start = performance.now();
        const bucket = (transactions[name] ??= {
          commits: 0,
          failures: 0,
          totalMs: 0,
          maxMs: 0,
        });
        try {
          const result = tx.immediate(...args);
          bucket.commits++;
          return result;
        } catch (error) {
          bucket.failures++;
          throw error;
        } finally {
          const elapsed = performance.now() - start;
          bucket.totalMs += elapsed;
          bucket.maxMs = Math.max(bucket.maxMs, elapsed);
        }
      };
    },
  };
}
