import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { CadData } from "@fmcad/core";
import type {
  RunInvocation,
  RunCommandReply,
  RunCommandServices,
} from "../packages/core/src/application/cad/worker-command";
import { PythonSimulator } from "./scenarios/simulator";
import { record, text } from "./scenarios/contracts";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
type Worker =
  typeof import("../packages/core/src/application/cad/worker-command");
const current = load(
  "./src/dist/core/application/cad/worker-command.js",
) as Worker;
const { preparePythonArtifact } = load(
  "./src/python.js",
) as typeof import("../packages/node-adapters/src/python/artifact");
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  file: string,
  runtime?: string,
) => unknown;
const previous = historical(
  "0e9afe17d5aa1f73660ffee18f0bbefa878b9b22",
  "packages/core/src/application/cad/worker-command.ts",
  "src/dist/core/application/cad/worker-command.js",
) as Worker;
const baseline = historical(
  "a26222ff617b0e9597b2a91b50474bdca8d0a0ce",
  "src/cli.js",
) as {
  main(
    argv: string[],
    dependencies: {
      stdout: { write(value: string): void };
      stderr: { write(value: string): void };
      setExitCode(value: number): void;
      loadConfig(): { cfg: { backend: string } };
      createBackend(): { callTool(): Promise<RunCommandReply> };
      buildRunScript(): string;
    },
  ): Promise<number>;
};
const source = 'DOC_NAME = ""\ndef run(_context):\n    print("user code")\n';
const input: RunInvocation = {
  version: 1,
  kind: "run",
  request: {
    name: "planned.py",
    args: null,
    hasArgs: false,
    doc: "Owned model",
    identity: { docId: "creation-A" },
    readOnlyOperations: [],
  },
};
const artifact = (source: string) =>
  preparePythonArtifact([
    { id: "user", filename: "planned.py", role: "user", source },
  ]);
const blocked = {
  status: "rejected-before-mutation",
  notStarted: true,
  activeCommand: "MoveCommand",
  identityAvailable: true,
};
const services = (
  execute: RunCommandServices["execution"]["execute"],
  code = source,
): RunCommandServices => ({
  prepare: () => artifact(code),
  execution: { execute },
  backend: "addin",
  async checkOutput() {
    assert.fail("Guard response must not check a publication target");
  },
  async publish() {
    assert.fail("Guard response must not publish user output");
  },
  outcome() {
    assert.fail("Guard response is not the underlying operation outcome");
  },
  redact: (value) => value,
});

for (const [label, guard, expected] of [
  ["proved rejection", blocked, false],
  ["unknown start", { ...blocked, status: "unknown", notStarted: false }, null],
  [
    "missing start evidence",
    { status: "rejected-before-mutation", activeCommand: "MoveCommand" },
    null,
  ],
  ["contradictory status", { ...blocked, status: "unknown" }, null],
  ["malformed start flag", { ...blocked, notStarted: "true" }, null],
] satisfies [string, CadData, boolean | null][]) {
  test(`run guard ${label} preserves uncertainty and never reports a submitted user script`, async () => {
    let calls = 0,
      stdout = "",
      stderr = "",
      exitCode = -1;
    const reply = { failed: true, text: "interactive command", uiGuard: guard };
    const code = await baseline.main(
      [
        "run",
        input.request.name,
        "--doc",
        input.request.doc!,
        "--doc-id",
        "creation-A",
      ],
      {
        stdout: {
          write(value) {
            stdout += value;
          },
        },
        stderr: {
          write(value) {
            stderr += value;
          },
        },
        setExitCode(value) {
          exitCode = value;
        },
        loadConfig: () => ({ cfg: { backend: "addin" } }),
        createBackend: () => ({
          async callTool() {
            calls++;
            return reply;
          },
        }),
        buildRunScript: () => source,
      },
    );
    assert.equal(code, 1, stderr);
    assert.equal(exitCode, 1);
    assert.equal(calls, 1);
    const old = record(JSON.parse(stdout) as unknown);
    assert.equal(old["userCodeSubmitted"], guard["notStarted"] === true);
    for (const worker of [previous, current]) {
      let submissions = 0;
      const result = await worker.executeRunCommand(
        input,
        services(async () => {
          submissions++;
          return reply;
        }),
      );
      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      assert.equal(submissions, 1);
      const receipt = record(JSON.parse(result.stdout) as unknown);
      if (worker === previous) assert.deepEqual(receipt, old);
      else {
        assert.equal(receipt["userCodeSubmitted"], expected);
        assert.equal(receipt["originalOperationOutcome"], "notEvaluated");
        assert.deepEqual(receipt["suggestedRecovery"], [
          "ui.inspect",
          "ui.resolve",
        ]);
        if (expected === null)
          assert.match(
            String(receipt["limitations"]),
            /does not establish.*no retry is automatic/,
          );
        else assert.deepEqual(receipt["limitations"], old["limitations"]);
        const oldRest = { ...old },
          newRest = { ...receipt };
        for (const key of ["userCodeSubmitted", "limitations"]) {
          delete oldRest[key];
          delete newRest[key];
        }
        assert.deepEqual(newRest, oldRest);
      }
    }
  });
}

test("ordinary run guard receipt is structured and distinct from underlying operation outcome", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "run-guard-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "planned.py");
  await fs.writeFile(file, source);
  const worker = load("./src/cad-service.js") as {
    execute(
      request: { payload: RunInvocation },
      client: {
        callTool(): Promise<RunCommandReply>;
        capabilities: { backend: string };
      },
      outcome: (value: unknown) => void,
      io: {
        stdout: { write(value: string): void };
        stderr: { write(value: string): void };
      },
    ): Promise<number>;
  };
  let calls = 0,
    stdout = "",
    stderr = "";
  const code = await worker.execute(
    { payload: { ...input, request: { ...input.request, name: file } } },
    {
      capabilities: { backend: "addin" },
      async callTool() {
        calls++;
        return { failed: true, text: "interactive command", uiGuard: blocked };
      },
    },
    () =>
      assert.fail("Guard receipt must not report a completed user operation"),
    {
      stdout: {
        write(value) {
          stdout += value;
        },
      },
      stderr: {
        write(value) {
          stderr += value;
        },
      },
    },
  );
  assert.equal(code, 1, stderr);
  assert.equal(calls, 1, stderr);
  const receipt = record(JSON.parse(stdout) as unknown);
  assert.equal(receipt["userCodeSubmitted"], false);
  assert.equal(receipt["activeCommand"], "MoveCommand");
  assert.equal(receipt["originalOperationOutcome"], "notEvaluated");
  assert.deepEqual(receipt["suggestedRecovery"], ["ui.inspect", "ui.resolve"]);
  assert.equal(await fs.readFile(file, "utf8"), source);
  assert.deepEqual(await fs.readdir(directory), ["planned.py"]);
});

for (const state of ["busy", "unreadable", "idle"] as const) {
  test(`actual add-in guard ${state} reports whether the model executed user code`, async (t) => {
    const model = new PythonSimulator(root);
    t.after(() => model.close());
    const setup = await model.execute(
      `import builtins, adsk.core
builtins._fmcad_guard_calls = 0
${
  state === "unreadable"
    ? `class UnreadableUI:
    @property
    def activeCommand(self):
        raise RuntimeError('injected unavailable identity')
adsk.core.Application.get().userInterface = UnreadableUI()`
    : `adsk.core.Application.get().userInterface.activeCommand = ${JSON.stringify(state === "busy" ? "MoveCommand" : "SelectCommand")}`
}`,
      false,
    );
    assert.equal(setup.success, true, setup.error);
    const { BrokerAddinClient } = load(
      "./src/dist/fusion-transport/addin.js",
    ) as typeof import("../packages/node-adapters/src/fusion-transport/addin");
    const client = new BrokerAddinClient(
      { url: "http://127.0.0.1:1/mcp", timeoutMs: 1000 },
      {
        version: "guard-test",
        requestTimeout: (server) => server.timeoutMs!,
        bridgeSource: () => assert.fail("No bridge expected"),
      },
    );
    let calls = 0;
    client._post = async (payload) => {
      if (payload["method"] === "initialize")
        return {
          status: 200,
          sessionId: "guard-test",
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload["id"],
            result: { protocolVersion: "2025-06-18" },
          }),
        };
      if (payload["method"] === "notifications/initialized")
        return { status: 202, raw: "" };
      assert.equal(payload["method"], "tools/call");
      calls++;
      const params = record(payload["params"]);
      assert.equal(params["name"], "execute_python");
      const physicalCode = text(record(params["arguments"])["code"]);
      assert.match(physicalCode, /FMCAD_UI_GUARD/);
      const result = await model.execute(physicalCode, false);
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload["id"],
          result: { content: [{ type: "text", text: JSON.stringify(result) }] },
        }),
      };
    };
    const result = await current.executeRunCommand(
      input,
      services(async (turn) => {
        const reply = await client.callTool({
          featureType: "script",
          object: { script: turn.artifact.script },
        });
        return {
          failed: reply.failed,
          text: reply.text,
          ...(reply.uiGuard ? { uiGuard: record(reply.uiGuard) } : {}),
        };
      }, 'import builtins\ndef run(_context):\n    builtins._fmcad_guard_calls += 1\n    print("USER_BODY_RAN")\n'),
    );
    assert.equal(calls, 1);
    const observed = await model.execute(
      "import builtins\nprint(builtins._fmcad_guard_calls)",
      false,
    );
    assert.equal(observed.success, true, observed.error);
    assert.equal(observed.stdout.trim(), state === "idle" ? "1" : "0");
    if (state === "idle") {
      assert.equal(result.code, 0);
      assert.match(result.stdout, /USER_BODY_RAN/);
    } else {
      assert.equal(result.code, 1);
      const receipt = record(JSON.parse(result.stdout) as unknown);
      assert.equal(receipt["userCodeSubmitted"], false);
      assert.equal(receipt["status"], "rejected-before-mutation");
      assert.equal(
        receipt["activeCommandIdentityAvailable"],
        state !== "unreadable",
      );
    }
  });
}
