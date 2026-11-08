"use strict";

const os = require("node:os");
const { createHash } = require("node:crypto");
const { QueueClient } = require("./queue-client");
const { BrokerControl } = require("./console-controller");
const { createServices } = require("./console-services");
const { buildHash } = require("./queue-instance");
const {
  createControlCenterSystemControls,
} = require("./dist/node-adapters/control-center/system-controls");

function controlClientId() {
  const identity = `${os.hostname()}\0${os.userInfo().username}`;
  return (
    "control-center:" + createHash("sha256").update(identity).digest("hex")
  );
}

/** Reuses the existing idle-only, start-paused lifecycle service. */
function createControlCenterSystemControlsRuntime(cfg, registeredProjectIds) {
  if (cfg?.routing !== "queue") {
    throw Object.assign(
      new Error("System controls require the configured queue routing backend"),
      { code: "UNSUPPORTED_ROUTING" },
    );
  }
  if (typeof registeredProjectIds !== "function") {
    throw Object.assign(
      new Error(
        "Registered project identities are required for scoped controls",
      ),
      { code: "PRINCIPAL_UNAVAILABLE" },
    );
  }
  let startService = null;
  let startServiceClient = null;
  const startStopped =
    cfg.routing === "queue"
      ? (_fence, client) => {
          if (!startService || startServiceClient !== client) {
            startService = createServices({
              cfg,
              control: new BrokerControl(() => client),
            });
            startServiceClient = client;
          }
          return startService.start();
        }
      : undefined;
  return createControlCenterSystemControls({
    client: () => new QueueClient(controlClientId()),
    buildHash,
    ...(startStopped ? { startStopped } : {}),
    authorize(principal, scope) {
      return (
        principal.globalRead &&
        (scope.kind === "global" ||
          registeredProjectIds().includes(scope.projectId))
      );
    },
  });
}

module.exports = { createControlCenterSystemControlsRuntime };
