"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { createRequire } = require("node:module");

const [runtimeRoot, repoRoot, dir, sourceJson, observationJson] =
  process.argv.slice(2);
const runtimeRequire = createRequire(
  path.join(runtimeRoot, "src/queue-broker.js"),
);
const { serve } = runtimeRequire("./queue-broker");
const { probe } = runtimeRequire("./queue-instance");
const { runBoundInstanceProbe } = require(
  path.join(repoRoot, "tests/fixtures/bound-instance-probe.cjs"),
);
const source = JSON.parse(sourceJson);
const observation = JSON.parse(observationJson);
const options = {
  dir,
  confirmOwnership: true,
  autoReconcile: false,
  nativePath: (file) => file,
  createBackend(config) {
    return {
      server: { timeoutMs: 1000 },
      _parse: (raw) => JSON.parse(raw),
      _openSession() {
        throw new Error("Unexpected session");
      },
      listTools() {
        throw new Error("Unexpected catalog");
      },
      executeUiGuardedScript() {
        throw new Error("Unexpected script");
      },
      _post() {
        throw new Error("Original job replay forbidden");
      },
      callTool(args) {
        if (process.send)
          process.send({ kind: "probe", backend: config.backend });
        return {
          failed: false,
          text: runBoundInstanceProbe(args.object.script, observation).text,
        };
      },
    };
  },
};

function send(value) {
  if (process.send) process.send(value);
}

let handle;
async function start(config, backendTransition, kind) {
  handle = await serve(config, {
    ...options,
    ...(backendTransition ? { backendTransition } : {}),
  });
  if (kind === "ready") {
    const marker = JSON.parse(
      fs.readFileSync(path.join(dir, "broker.lock"), "utf8"),
    );
    const lifecycle = JSON.parse(
      fs.readFileSync(
        path.join(dir, `broker-lifecycle-${marker.nonce}.json`),
        "utf8",
      ),
    );
    const client = options.createBackend(config);
    await probe(client, {
      receiptPath: lifecycle.receipt,
      binding: lifecycle.binding,
      requireIdle: false,
      mapPath: (file) => file,
    });
  }
  send({ kind, status: handle.status() });
}

process.on("message", (message) => {
  if (message?.action === "exit") {
    void (async () => {
      await handle?.close();
      send({ kind: "exited" });
      process.disconnect();
    })().catch(report);
  }
});

function report(error) {
  send({
    kind: "error",
    code: error?.code,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}

void start(source, undefined, "ready").catch(report);
