import { createHash } from "node:crypto";
import { createConnection, createServer } from "node:net";

const limit = 1024 * 1024;

export function fail(code) {
  throw Object.assign(new Error(code), { code });
}

// Inputs in this experiment have already crossed a JSON-only wire.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hash(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function listen(path, handle) {
  const server = createServer((socket) => {
    const lifetime = new AbortController();
    socket.once("close", () => lifetime.abort());
    let bytes = 0;
    let frame = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.setTimeout(30_000, () => socket.destroy());
    function receive(chunk) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit) return socket.destroy();
      frame += chunk;
      const newline = frame.indexOf("\n");
      if (newline < 0) return;
      socket.off("data", receive);
      Promise.resolve()
        .then(() =>
          handle(JSON.parse(frame.slice(0, newline)), lifetime.signal),
        )
        .then(
          (value) => ({ value }),
          (error) => ({ error: error.code ?? "INTERNAL" }),
        )
        .then((reply) => socket.end(`${JSON.stringify(reply)}\n`));
    }
    socket.on("data", receive);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
}

export function ask(path, message, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let frame = "";
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () =>
      socket.destroy(
        Object.assign(new Error("Client wait expired"), {
          code: "WAIT_TIMEOUT",
        }),
      ),
    );
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("error", reject);
    socket.on("close", () =>
      reject(Object.assign(new Error("Reply lost"), { code: "REPLY_LOST" })),
    );
    socket.on("data", (chunk) => {
      frame += chunk;
      if (Buffer.byteLength(frame) > limit)
        return socket.destroy(new Error("Reply exceeds limit"));
      const newline = frame.indexOf("\n");
      if (newline < 0) return;
      try {
        const reply = JSON.parse(frame.slice(0, newline));
        if (reply.error) fail(reply.error);
        resolve(reply.value);
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
  });
}
