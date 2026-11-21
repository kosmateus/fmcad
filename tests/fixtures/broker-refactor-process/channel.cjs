"use strict";
const { fork } = require("node:child_process");
const path = require("node:path");

// Messages are retained before a waiter is attached: no timing sleeps and no
// missed barrier when a child reaches a boundary before the test's next await.
function start(file, args, env) {
  const child = fork(path.join(__dirname, file), args, {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const events = [];
  const waiters = new Set();
  let stderr = "",
    sequence = 0,
    exited = false;
  child.stdout.on("data", () => {});
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const exit = new Promise((resolve) =>
    child.once("exit", (code, signal) => {
      exited = true;
      resolve({ code, signal });
      for (const waiter of waiters)
        waiter.reject(
          new Error(`${file} exited (${code}/${signal}): ${stderr}`),
        );
      waiters.clear();
    }),
  );
  child.on("message", (message) => {
    events.push(message);
    for (const waiter of [...waiters])
      if (waiter.matches(message)) {
        waiters.delete(waiter);
        waiter.resolve(message);
      }
  });
  function wait(matches) {
    const found = events.find(matches);
    if (found) return Promise.resolve(found);
    if (exited)
      return Promise.reject(new Error(`${file} already exited: ${stderr}`));
    return new Promise((resolve, reject) =>
      waiters.add({ matches, resolve, reject }),
    );
  }
  return {
    child,
    events,
    exit,
    event(name, tag) {
      return wait(
        (m) => m.event === name && (tag === undefined || m.tag === tag),
      );
    },
    async call(action, values = {}) {
      const id = ++sequence;
      const reply = wait((m) => m.reply === id);
      child.send({ id, action, ...values });
      const message = await reply;
      if (message.error)
        throw Object.assign(new Error(message.error.message), message.error);
      return message.value;
    },
    async kill() {
      if (!exited) child.kill("SIGKILL");
      return exit;
    },
  };
}

function respond(handler) {
  process.on("message", async (message) => {
    try {
      const value = await handler(message);
      process.send?.({ reply: message.id, value });
    } catch (error) {
      process.send?.({
        reply: message.id,
        error: { message: error.message, code: error.code },
      });
    }
  });
}
module.exports = { start, respond };
