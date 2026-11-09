"use strict";

const crypto = require("node:crypto");
const { QueueClient } = require("../../src/queue-client");
const {
  createControlCenterHttpServer,
} = require("../../packages/control-center/dist/server/http");
const {
  CONTROL_CENTER_PROTOCOL_VERSION,
} = require("../../packages/control-center/dist/server/protocol");
const {
  composeControlCenterService,
} = require("../../packages/control-center/dist/server/composition");
const {
  createControlCenterSystemControls,
} = require("../../packages/node-adapters/dist/control-center/system-controls");
const {
  SystemControlsClient,
  createSystemControlCommand,
} = require("../../packages/control-center/dist/web/system-controls");

const client = new QueueClient(process.argv[2]);
process.send({ ready: true, queueDirectory: client.dir, auth: client.auth });

async function run(port, browserMode = false) {
  let runtime;
  let composition;
  let server;
  let observedStatus;
  try {
    runtime = createControlCenterSystemControls({
      client,
      buildHash: () => "a".repeat(64),
      authorize: (principal, scope) =>
        principal.globalRead &&
        (scope.kind === "global" ||
          principal.projectIds.includes(scope.projectId)),
    });
    composition = composeControlCenterService({
      readPort: null,
      resolvePrincipal: (session) => ({
        subject: session.subject,
        projectIds: ["fixture-project"],
        globalRead: true,
      }),
      subscribeRevisions: () => () => {},
      systemControls: runtime.handle,
      close: runtime.close,
    });
    server = createControlCenterHttpServer({
      identity: {
        port,
        buildIdentity: "fixture-http-build",
        protocolVersion: CONTROL_CENTER_PROTOCOL_VERSION,
        pid: process.pid,
        processBirth: `fixture:${process.pid}`,
        instanceNonce: crypto.randomBytes(32).toString("hex"),
        probeSecret: crypto.randomBytes(32).toString("hex"),
      },
      assets: browserMode
        ? require("../../src/dist/control-center/resources").loadConsoleHttpAssets(
            require("node:path").resolve("dist"),
          )
        : [
            {
              path: "/index.html",
              contentType: "text/html; charset=utf-8",
              body: "<!doctype html><title>offline System controls fixture</title>",
            },
          ],
      query: composition.query,
      resolvePrincipal: composition.resolvePrincipal,
      ...(composition.systemControls
        ? { systemControls: composition.systemControls }
        : {}),
    });
    await server.start();
    if (browserMode) {
      process.send({ browserReady: true, port });
      await new Promise((resolve) => process.once("disconnect", resolve));
      return;
    }

    const origin = `http://localhost:${port}`;
    let cookie = "";
    const fetcher = async (input, init = {}) => {
      const headers = new Headers(init.headers);
      if (cookie) headers.set("cookie", cookie);
      if (init.method === "POST" && !headers.has("origin"))
        headers.set("origin", origin);
      const response = await fetch(input, { ...init, headers });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";", 1)[0];
      return response;
    };
    const landing = await fetcher(origin);
    if (!landing.ok)
      throw new Error("Fixture home page did not create a session");
    await landing.arrayBuffer();
    const storage = new Map();
    const browser = new SystemControlsClient(origin, fetcher, {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    });
    const status = await browser.status({ kind: "global" });
    observedStatus = status;
    const command = createSystemControlCommand(
      status,
      { kind: "global" },
      "pause",
    );
    const receipt = await browser.execute(command);
    process.send({
      result: {
        state: receipt.state,
        phase: receipt.snapshot?.phase ?? null,
        requestId: receipt.requestId,
        instanceId: receipt.instanceId,
        clientId: client.auth.clientId,
      },
    });
  } catch (error) {
    process.send({
      error: {
        code:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "FIXTURE_FAILED",
        message: error instanceof Error ? error.message : "Fixture failed",
        status: observedStatus,
      },
    });
  } finally {
    if (server) await server.close().catch(() => {});
    if (composition) await composition.close().catch(() => {});
    else runtime?.close();
    client.dispose();
    process.exit(0);
  }
}

process.on("message", (message) => {
  if (message?.action === "run")
    void run(message.port, message.browser === true);
});
