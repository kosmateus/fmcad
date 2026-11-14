import { createRequire } from "node:module";
import type { TestContext } from "node:test";
import { object } from "./modeling-unit-test-support.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fixtureDirectory = path.join(process.cwd(), "tests");
const load = createRequire(
  path.join(fixtureDirectory, "definition-mode.test.ts"),
);
const { main } = load(
  "../src/cli",
) as import("./modeling-unit-test-support.js").ModelingFixtureCli;
const { catalog, validateCad } = load(
  "../src/cad",
) as typeof import("../src/composition/cad-execution.js");
const { runBatch, definitionInstantiate, validateBatch } = load(
  "../src/batch",
) as typeof import("../src/composition/batch.js");

const invalidModes = [null, false, 0, "", true, 1, "RUN", "invalid", [], {}];
const modeError = "mode must be validate, preview, or run";
const request = (reportPath: string) => ({
  runId: "mode-test",
  reportPath,
  operations: [
    { id: "bodies", operation: "entity.list", data: { kind: "body" } },
  ],
});

async function directory(t: TestContext) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "fmcad-definition-mode-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("invalid explicit modes fail shared validation and runners before executor or reports", async (t) => {
  const dir = await directory(t);
  for (const mode of [...invalidModes, undefined]) {
    const data = { ...request(path.join(dir, "absent")), mode };
    assert.deepEqual(validateBatch(data, catalog).errors, [modeError]);
    assert.throws(() => validateCad("definition.instantiate", data), {
      message: modeError,
    });
    for (const runner of [runBatch, definitionInstantiate]) {
      for (const preview of [false, true]) {
        const result = object(
          await runner(
            null,
            data,
            { preview },
            () => assert.fail("executor accessed"),
            catalog,
          ),
        );
        assert.equal(result["success"], false);
        assert.equal(result["mutated"], false);
        assert.deepEqual(result["errors"], [modeError]);
      }
    }
  }
  assert.deepEqual(await fs.readdir(dir), []);
});

function cliHarness() {
  const calls = { config: 0, backend: 0, tool: 0 };
  const sessions = { created: 0, disposed: 0 };
  let stdout = "";
  let stderr = "";
  return {
    calls,
    sessions,
    output: () => stdout,
    error: () => stderr,
    deps: {
      loadConfig: () => {
        calls.config++;
        return {
          cfg: {
            backend: "mcp",
            routing: "queue",
            url: "http://127.0.0.1:1/mcp",
            headers: {},
            timeoutMs: 1000,
            tool: "execute_python",
            transport: "node",
            protocolVersion: "2025-06-18",
            queue: { autoStart: false },
          },
        };
      },
      createBackend() {
        assert.fail("CLI must not construct a direct backend");
      },
      McpClient: class {
        constructor() {
          assert.fail("CLI must not construct a direct client");
        }
      },
      createFmcad(options: { config: { routing?: string } }) {
        assert.equal(options.config.routing, "queue");
        sessions.created++;
        let started = false;
        const client = {
          async callTool() {
            calls.tool++;
            return {
              text:
                "FMCAD_RESULT " +
                JSON.stringify({ success: true, result: { entities: [] } }),
            };
          },
        };
        return {
          async start() {
            started = true;
            calls.backend++;
          },
          async dispose() {
            sessions.disposed++;
          },
          async execute(
            value: { kind?: string; invocation?: unknown },
            execution: { requestId: string },
          ) {
            assert.equal(value.kind, "cad-command");
            assert.ok(execution.requestId);
            const result = await (
              load(
                "../src/catalog/execute",
              ) as typeof import("../src/composition/catalog-execution.js")
            ).executeInvocation(value.invocation, started ? client : null);
            return {
              version: 1,
              requestId: execution.requestId,
              jobId: started ? "mode-job" : null,
              state: started ? "succeeded" : "local",
              result,
              output: { stdout: JSON.stringify(result) + "\n", stderr: "" },
              outcome: {
                acceptance: "accepted",
                executionOutcome: "succeeded",
                validation: { status: "not_checked" },
              },
            };
          },
        };
      },
      stdout: {
        write: (text: string) => {
          stdout += text;
        },
      },
      stderr: {
        write: (text: string) => {
          stderr += text;
        },
      },
      setExitCode: () => {},
    },
  };
}

test("CLI rejects invalid definition modes before config/backend/report access even with --preview", async (t) => {
  const dir = await directory(t);
  for (const mode of invalidModes) {
    for (const flags of [[], ["--preview"]]) {
      const harness = cliHarness();
      const data = { ...request(path.join(dir, "absent")), mode };
      const code = await main(
        [
          "definition",
          "instantiate",
          "--doc",
          "Model",
          "--data",
          JSON.stringify(data),
          ...flags,
        ],
        harness.deps,
      );
      assert.equal(code, 1);
      assert.equal(harness.error(), `ERROR ${modeError}\n`);
      assert.equal(harness.output(), "");
      assert.deepEqual(harness.calls, { config: 0, backend: 0, tool: 0 });
    }
  }
  assert.deepEqual(await fs.readdir(dir), []);
});

test("CLI preserves omitted/explicit run, validate/preview, and valid --preview overrides", async (t) => {
  const dir = await directory(t);
  let index = 0;
  for (const mode of [undefined, "run", "validate", "preview"]) {
    for (const preview of [false, true]) {
      const reportPath = path.join(dir, String(index++));
      const data = {
        ...request(reportPath),
        ...(mode === undefined ? {} : { mode }),
      };
      const harness = cliHarness();
      const code = await main(
        [
          "definition",
          "instantiate",
          "--doc",
          "Model",
          "--data",
          JSON.stringify(data),
          ...(preview ? ["--preview"] : []),
        ],
        harness.deps,
      );
      assert.equal(code, 0, harness.error());
      const result = object(JSON.parse(harness.output()));
      assert.equal(result["success"], true);
      assert.equal(result["operation"], "definition.instantiate");
      const live = !preview && (mode === undefined || mode === "run");
      assert.deepEqual(harness.calls, {
        config: Number(live),
        backend: Number(live),
        tool: Number(live),
      });
      assert.deepEqual(harness.sessions, { created: 1, disposed: 1 });
      if (live) {
        assert.equal(result["status"], "success");
        assert.ok((await fs.readdir(reportPath)).includes("00000000.json"));
      } else {
        assert.equal(result["mode"], preview ? "preview" : mode);
        assert.equal(result["mutated"], false);
        await assert.rejects(fs.access(reportPath), { code: "ENOENT" });
      }
    }
  }
});
