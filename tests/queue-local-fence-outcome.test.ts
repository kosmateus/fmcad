import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

type Job = {
  id: string;
  state: string;
  sequenceId: string;
  sequenceState: string;
  code: string;
  userScriptSubmitted: boolean;
  finishedAt: number;
  operationResult: { executionOutcome: string; mayHaveMutated: boolean };
};
type Result = { job: Job; stdout: string };
const load = createRequire(
  path.join(process.cwd(), "tests", "queue-local-fence-outcome.test.js"),
);
// Explicit fake physical backends require only synthetic WSL path spelling.
test.beforeEach((t) =>
  (t as test.TestContext).after(
    (load("./fixtures/fake-wsl-platform.cjs") as () => () => void)(),
  ),
);

test(
  "pre-dispatch fence rejection publishes its local outcome before any job directory exists",
  { timeout: 15000 },
  async (t) => {
    const dir = fs.mkdtempSync("/tmp/opencode/local-fence-outcome-");
    let broker:
      | Awaited<ReturnType<typeof import("../src/queue-broker").serve>>
      | undefined = undefined;
    t.after(async () => {
      try {
        await broker?.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    const identity = {
      pid: 99,
      birth: "fixture:99",
      version: "fixture",
      activeCommand: "SelectCommand",
      documents: [],
    };
    let preparations = 0,
      physical = 0;
    const backend = {
      server: { timeoutMs: 1000 },
      _parse: JSON.parse,
      _post() {
        assert.fail("Rejected product RPC must never be sent");
      },
      async callTool(value: import("../src/queue-broker-ports").ToolArguments) {
        physical++;
        const script = value.object!.script!;
        const binding = script.match(
          /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/,
        );
        const file = script.match(/_qr_path = ("(?:\\.|[^"\\])*")/);
        assert.ok(binding && file);
        const local = (JSON.parse(file[1]!) as string)
          .replace(/^\\\\wsl(?:\$|\.localhost)\\[^\\]+/, "")
          .replaceAll("\\", "/");
        fs.writeFileSync(
          local,
          JSON.stringify({
            ...(JSON.parse(JSON.parse(binding[1]!) as string) as Record<
              string,
              unknown
            >),
            terminal: true,
            outcome: "succeeded",
            instance: identity,
          }),
        );
        return {
          failed: false,
          text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(identity),
        };
      },
      async prepareCallTool(
        value: import("../src/queue-broker-ports").ToolArguments,
      ) {
        const preparation = ++preparations;
        return Object.assign(() => this.callTool(value), {
          fence() {
            if (preparation > 1)
              throw Object.assign(
                new Error(
                  "Synthetic exact-byte fence rejected before dispatch",
                ),
                { code: "FIXTURE_FENCE_REJECTED" },
              );
          },
        });
      },
    };
    broker = await (
      load("../src/queue-broker") as typeof import("../src/queue-broker")
    ).serve(
      { backend: "mcp", timeoutMs: 1000 },
      {
        dir,
        confirmOwnership: true,
        createBackend: () =>
          backend as unknown as import("../src/queue-broker-ports").Client,
        pollMs: 5,
      },
    );
    const { request: wireRequest } = load(
      "../src/queue-connection",
    ) as typeof import("../src/entrypoints/queue-connection");
    const request = <T = unknown>(message: Record<string, unknown>) =>
      wireRequest(dir, message) as Promise<T>;
    const auth = {
      clientId: "local-fence-fixture",
      clientToken: "private-synthetic-token",
    };
    await request({ action: "register", ...auth });
    const job = await request<Job>({
      action: "submit",
      auth,
      request: {
        kind: "rpc",
        requestId: "one-rejected-local-request",
        timeoutMs: 1000,
        payload: { jsonrpc: "2.0", id: "ping", method: "ping" },
      },
    });
    const deadline = Date.now() + 3000;
    let result: Result;
    do {
      result = await request<Result>({ action: "result", auth, jobId: job.id });
      if (result.job.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    } while (Date.now() < deadline);
    assert.equal(result.job.state, "failed", JSON.stringify(result));
    assert.equal(result.job.code, "FIXTURE_FENCE_REJECTED");
    assert.equal(result.job.operationResult.executionOutcome, "not_started");
    assert.equal(result.job.operationResult.mayHaveMutated, false);
    assert.equal(broker.status().blocked, null);
    assert.equal(
      physical,
      1,
      "Only the startup observation was invoked; no preflight/product replay",
    );
    assert.equal(
      (
        JSON.parse(
          fs.readFileSync(
            path.join(dir, "jobs", job.id, "outcome.json"),
            "utf8",
          ),
        ) as { code: string }
      ).code,
      "FIXTURE_FENCE_REJECTED",
    );
  },
);
