import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { EventSink } from "@fmcad/core";
const load = createRequire(__filename);
const { createTelemetryEventSink } = load(
  "../node-adapters/telemetry/event-sink",
) as typeof import("../../packages/node-adapters/src/telemetry/event-sink");
export interface QueueLocations {
  queueDir: string;
  stateDir: string;
  socket: string;
}
export interface ProjectEventOptions {
  queueDir?: string;
}
export interface ObserverResponse {
  ok: true;
  readonly [key: string]: unknown;
}
const sha = (value: unknown) =>
  createHash("sha256").update(String(value)).digest("hex");
const defaults = () =>
  path.join(
    process.env["XDG_STATE_HOME"] || path.join(os.homedir(), ".local", "state"),
    "fmcad",
    "queue",
  );
export function locations(queueDir = defaults()): QueueLocations {
  queueDir = path.resolve(queueDir);
  const key = sha((process.getuid?.() ?? "user") + ":" + queueDir).slice(0, 28);
  return {
    queueDir,
    stateDir: path.join(path.dirname(queueDir), "project-logs-" + key),
    socket: "\0fmcad-project-logs-" + key,
  };
}

export function readJson(file: string): unknown {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    if (!fs.fstatSync(fd).isFile())
      throw Object.assign(Error("Not a regular snapshot"), {
        code: "INVALID_SNAPSHOT",
      });
    return JSON.parse(fs.readFileSync(fd, "utf8")) as unknown;
  } finally {
    fs.closeSync(fd);
  }
}

export function ipc(
  config: Pick<QueueLocations, "socket">,
  message: Record<string, unknown> = { method: "status" },
): Promise<ObserverResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: config.socket });
    let text = "",
      done = false;
    const finish = (error: unknown, value?: ObserverResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(
      () =>
        finish(
          Object.assign(Error("Logger IPC timeout"), {
            code: "LOGGER_TIMEOUT",
          }),
        ),
      700,
    );
    socket.once("connect", () => socket.write(JSON.stringify(message) + "\n"));
    socket.on("error", (error) => finish(error));
    socket.on("data", (bytes) => {
      text += bytes.toString("utf8");
      if (text.length > 8192) return finish(Error("Logger response too large"));
      if (!text.includes("\n")) return;
      try {
        const value = JSON.parse(
          text.slice(0, text.indexOf("\n")),
        ) as ObserverResponse;
        if (value.ok === true) finish(null, value);
        else finish(Error("Logger request rejected"));
      } catch (error) {
        finish(error);
      }
    });
    socket.once("end", () => {
      if (!done) finish(Error("Logger disconnected"));
    });
  });
}

export function createEventSink(
  cwd: string,
  options: ProjectEventOptions = {},
): EventSink {
  const config = locations(options.queueDir);
  return createTelemetryEventSink(async (event) => {
    if (process.env["FMCAD_PROJECT_LOGS"] === "0") return;
    const control = readJson(path.join(config.stateDir, "observer.json")) as {
      token: unknown;
    };
    await ipc(config, {
      method: "observation",
      token: control.token,
      cwd,
      event,
    });
  });
}
