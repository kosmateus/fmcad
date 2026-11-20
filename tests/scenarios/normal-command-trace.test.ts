import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  submitNormalCommand,
  type NormalTraceRuntime,
} from "../live-normal-multidocument";
import type { Queue, Job, Result } from "../live-recovery-ports";
import { createDebugTraceContext } from "../../packages/node-adapters/src/telemetry/diagnostic-log";

for (const mode of [
  "off",
  "success",
  "submit-failure",
  "wait-failure",
  "trace-failure",
  "runtime-loader",
]) {
  test(`normal command trace preserves execution: ${mode}`, async (t) => {
    const previous = process.env["FMCAD_DEBUG_TRACE"];
    process.env["FMCAD_DEBUG_TRACE"] = mode === "off" ? "0" : "1";
    t.after(() => {
      if (previous === undefined) delete process.env["FMCAD_DEBUG_TRACE"];
      else process.env["FMCAD_DEBUG_TRACE"] = previous;
    });
    const directory = fs.mkdtempSync("/tmp/opencode/normal-trace-");
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const job: Job = {
      id: "job",
      requestId: "request",
      clientId: "client",
      state: "succeeded",
    };
    const result: Result = { job, stdout: "", execution: { sdkSettled: true } };
    const failure = new Error("original failure");
    let submits = 0,
      waits = 0,
      accepts = 0,
      reads = 0;
    const input = { requestId: "request", timeoutMs: 180000 };
    const queue: Queue = {
      auth: { clientId: "client" },
      async register() {},
      async call() {},
      dispose() {},
      async submit(value) {
        submits++;
        assert.deepEqual(
          value,
          mode === "off"
            ? input
            : {
                ...input,
                debugTrace: createDebugTraceContext(
                  "request",
                  "client",
                  "cli",
                  true,
                ),
              },
        );
        if (mode === "submit-failure") throw failure;
        return job;
      },
      async wait() {
        waits++;
        if (mode === "wait-failure") throw failure;
        return result;
      },
    };
    const telemetry: NormalTraceRuntime = {
      createDebugTraceContext,
      async flushDebugTrace() {},
      readDebugTrace() {
        reads++;
        if (mode === "trace-failure") throw new Error("trace");
        return [];
      },
    };
    const run = submitNormalCommand(
      queue,
      input,
      () => {
        accepts++;
      },
      directory,
      mode === "runtime-loader" ? undefined : telemetry,
    );
    if (mode.endsWith("-failure") && mode !== "trace-failure")
      await assert.rejects(run, (error) => error === failure);
    else assert.equal(await run, result);
    assert.equal(submits, 1);
    assert.equal(waits, mode === "submit-failure" ? 0 : 1);
    assert.equal(accepts, waits);
    assert.equal(reads, ["off", "runtime-loader"].includes(mode) ? 0 : 1);
    assert.equal(
      fs.readdirSync(directory).length,
      ["off", "trace-failure"].includes(mode) ? 0 : 1,
    );
    assert.deepEqual(input, { requestId: "request", timeoutMs: 180000 });
  });
}
