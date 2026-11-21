import { broker } from "../broker.mjs";
import { receiver } from "../receiver.mjs";
import { ask, listen } from "../wire.mjs";
import Database from "better-sqlite3";

const [role, encodedConfig] = process.argv.slice(2);
const config = JSON.parse(encodedConfig);
const send = (message) => process.send(message);
const notify = (kind, value) => send({ kind, value });
const waiting = new Map();
const gate = async (site, value) => {
  const base = `${site}:${value.requestId ?? value.request_id}`;
  const key = config.gates?.find(
    (entry) => entry === base || entry === `${base}:${value.phase}`,
  );
  if (!key) return;
  await new Promise((resolve) => {
    waiting.set(key, resolve);
    send({ kind: "gate", key, value });
  });
};

process.on("disconnect", () => process.exit());
if (role === "lock") {
  const db = new Database(config.database, { fileMustExist: true });
  db.exec("BEGIN IMMEDIATE");
  process.on("message", () => {
    db.exec("ROLLBACK");
    db.close();
    process.exit(0);
  });
  send({ kind: "ready", pid: process.pid });
} else if (role === "client") {
  process.on("message", async ({ id, op, args, timeoutMs }) => {
    try {
      const value = await ask(
        config.socket,
        { op, token: config.token, ...args },
        timeoutMs,
      );
      send({ kind: "reply", id, value });
    } catch (error) {
      send({ kind: "reply", id, error: error.code ?? "INTERNAL" });
    }
  });
  send({ kind: "ready", pid: process.pid });
} else {
  process.on("message", ({ release }) => {
    const resume = waiting.get(release);
    if (!resume) throw new Error(`No waiter at ${release}`);
    waiting.delete(release);
    resume();
  });
  try {
    let handler;
    // Kernel bind is the single broker ownership check; do not open SQLite as a loser.
    await listen(config.socket, (...args) => {
      if (!handler)
        throw Object.assign(new Error("Starting"), { code: "STARTING" });
      return handler(...args);
    });
    handler =
      role === "broker"
        ? await broker(config, gate, notify)
        : receiver(config, gate, notify);
    if (config.corruptReplyFor) {
      const actual = handler;
      handler = async (message, signal) => {
        const result = await actual(message, signal);
        if (
          message.op === "dispatch" &&
          message.call.requestId === config.corruptReplyFor &&
          result.receipt
        ) {
          result.receipt.call = { ...result.receipt.call, owner: "unrelated" };
        }
        return result;
      };
    }
    send({ kind: "ready", pid: process.pid });
  } catch (error) {
    process.send(
      { kind: "startup-error", code: error.code, message: error.message },
      () => process.exit(1),
    );
  }
}
