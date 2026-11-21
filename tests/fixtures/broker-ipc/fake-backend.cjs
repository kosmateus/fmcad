"use strict";

const { runBoundInstanceProbe } = require("../bound-instance-probe.cjs");

module.exports = function createFakeBackend() {
  const identity = {
    pid: 4242,
    birth: "broker-ipc-contract:4242",
    version: "offline-contract",
    activeCommand: "SelectCommand",
    documents: [],
  };
  const sends = [];
  const calls = { toolCalls: 0 };
  const postBarriers = [];
  const holdNextPost = () => {
    let markStarted;
    let release;
    let finished = false;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise((resolve) => {
      release = resolve;
    });
    const barrier = {
      started,
      release,
      get finished() {
        return finished;
      },
      async block() {
        markStarted();
        await released;
        finished = true;
      },
    };
    postBarriers.push(barrier);
    return barrier;
  };

  return {
    sends,
    holdNextPost,
    get toolCalls() {
      return calls.toolCalls;
    },
    client: {
      server: { timeoutMs: 5000, headers: {} },
      _parse: JSON.parse,
      async _openSession() {
        return "offline-contract-session";
      },
      async _post(payload) {
        sends.push(structuredClone(payload));
        const barrier = postBarriers.shift();
        if (barrier) await barrier.block();
        return {
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: { echo: payload.params ?? null },
          }),
        };
      },
      async callTool(value) {
        calls.toolCalls++;
        const result = runBoundInstanceProbe(
          value?.object?.script || "",
          identity,
        );
        return {
          failed: false,
          text:
            result.text
              .split(/\r?\n/)
              .find((line) => line.startsWith("FMCAD_QUEUE_INSTANCE ")) ||
            "FMCAD_QUEUE_INSTANCE " + JSON.stringify(identity),
        };
      },
    },
  };
};
