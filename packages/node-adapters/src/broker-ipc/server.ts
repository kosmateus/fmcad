import * as fs from "node:fs";
import * as net from "node:net";

export const MAX_BROKER_IPC_BYTES = 16 * 1024 * 1024;

type Failure = {
  code: string;
  message: string | undefined;
  pythonCheck?: unknown;
  notStarted?: true;
};
type Reply = { ok: true; result: unknown } | { ok: false; error: Failure };

/** The caller owns endpoint exclusivity, stale-path removal, and broker drain. */
export async function listenBrokerIpc(
  endpoint: string,
  handle: (message: unknown) => Promise<unknown>,
  observeReply?: (message: unknown, ok: boolean, code?: string) => void,
) {
  const sockets = new Set<net.Socket>();
  const awaitingReply = new Set<net.Socket>();
  let closing = false;
  const server = net.createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      awaitingReply.delete(socket);
    });
    socket.on("error", () => {});
    socket.setTimeout(30000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let consumed = false;

    function respond(reply: Reply, message?: unknown) {
      if (socket.destroyed) return;
      let text = JSON.stringify(reply);
      if (Buffer.byteLength(text) > MAX_BROKER_IPC_BYTES) {
        reply = {
          ok: false,
          error: {
            code: "RESPONSE_TOO_LARGE",
            message: "Response exceeds 16 MiB; use output file metadata",
          },
        };
        text = JSON.stringify(reply);
      }
      try {
        observeReply?.(
          message,
          reply.ok,
          reply.ok ? undefined : reply.error.code,
        );
      } catch {
        // Optional observation must not prevent the wire reply.
      }
      socket.end(text + "\n");
      awaitingReply.delete(socket);
      if (closing) socket.destroySoon();
    }

    socket.on("data", (chunk) => {
      if (closing || consumed) return;
      // The entire chunk counts before we look for the first newline.
      if (buffer.length + chunk.length > MAX_BROKER_IPC_BYTES) {
        consumed = true;
        respond({
          ok: false,
          error: {
            code: "MESSAGE_TOO_LARGE",
            message: "Request exceeds 16 MiB",
          },
        });
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      consumed = true;
      socket.setTimeout(0); // Disconnect never cancels an accepted operation.
      let message: unknown;
      try {
        message = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      } catch {
        respond({
          ok: false,
          error: { code: "INVALID_JSON", message: "Invalid JSON request" },
        });
        return;
      }
      awaitingReply.add(socket);
      Promise.resolve()
        .then(() => handle(message))
        .then(
          (result) => respond({ ok: true, result }, message),
          (error: Partial<Failure>) =>
            respond(
              {
                ok: false,
                error: {
                  code: error.code || "BROKER_ERROR",
                  message: error.code
                    ? error.message
                    : "Broker operation failed; inspect private durable records",
                  ...(error.pythonCheck
                    ? { pythonCheck: error.pythonCheck }
                    : {}),
                  ...(error.notStarted === true ? { notStarted: true } : {}),
                },
              },
              message,
            ),
        )
        // A failed encoding/write cannot keep an accepted socket open forever.
        .catch(() => socket.destroy());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  if (process.platform !== "win32") fs.chmodSync(endpoint, 0o600);

  return {
    onError(onError: () => void) {
      server.on("error", onError);
    },
    stopListening() {
      server.close();
    },
    close() {
      closing = true;
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      // Replies for accepted frames own their writable side until respond().
      // Idle or incomplete clients cannot keep shutdown open.
      for (const socket of sockets)
        if (!awaitingReply.has(socket)) socket.destroySoon();
      return closed;
    },
  };
}
