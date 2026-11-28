import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { createRequire } from "node:module";

const runtimeRequire = createRequire(import.meta.url);

test(
  "public document inspections and acceptance observe one slow original reply without replay",
  { timeout: 45000 },
  async () => {
    const directory = fs.mkdtempSync("/tmp/opencode/unlock-ipc-deadline-");
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = directory;
    const { QueueClient } = runtimeRequire("../src/queue-client.js");
    const { queueSocket } = runtimeRequire("../src/queue-connection.js");
    const seen = [];
    const sockets = new Set();
    const timers = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      let bytes = "";
      socket.on("data", (chunk) => {
        bytes += chunk.toString();
        if (!bytes.includes("\n")) return;
        const request = JSON.parse(bytes.split("\n")[0]);
        seen.push(request);
        const timer = setTimeout(() => {
          timers.delete(timer);
          socket.end(
            JSON.stringify({
              ok: true,
              result: {
                state:
                  request.request.action === "inspect"
                    ? "inspection_required"
                    : "checkpoint_current",
                originalRequestId: request.request.requestId,
              },
            }) + "\n",
          );
        }, 31000);
        timers.add(timer);
      });
    });
    const client = new QueueClient("deadline-owned-client");
    try {
      assert.ok(
        client.dir.startsWith(directory + path.sep),
        "Fixture must not connect to canonical queue",
      );
      server.listen(queueSocket(client.dir));
      await once(server, "listening");
      const results = await Promise.allSettled(
        ["inspect", "accept"].map((action) =>
          client.documentUnlock({
            action,
            target: { docId: "owned-document" },
            requestId: `original-${action}`,
            ...(action === "accept"
              ? { observationId: "owned-observation" }
              : {}),
          }),
        ),
      );
      for (const [index, result] of results.entries()) {
        assert.equal(result.status, "fulfilled", String(result.reason));
        assert.equal(
          result.value.originalRequestId,
          `original-${index === 0 ? "inspect" : "accept"}`,
        );
      }
      assert.equal(
        seen.length,
        2,
        "Each original request is sent exactly once",
      );
      assert.deepEqual(seen.map((value) => value.request.requestId).sort(), [
        "original-accept",
        "original-inspect",
      ]);
    } finally {
      client.dispose();
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
