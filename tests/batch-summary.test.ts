import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { BatchReport, BatchCatalog } from "@fmcad/core";
import type { CadWorkerInvocation, JsonValue } from "../src/api/contracts.js";
import type { NativeActionClient } from "../packages/node-adapters/src/python/native-actions.js";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const { main } = load(
  "./src/cli.js",
) as typeof import("../src/entrypoints/cli.js");
const { catalog } = load("./src/cad.js") as {
  catalog: BatchCatalog & Record<string, { summaryFlag?: boolean }>;
};
const { commands } = load("./src/commands.js") as {
  commands: { kind: string; target: string; key: string }[];
};
const { detail } = load("./src/help.js") as {
  detail(...args: string[]): string;
};
const { runBatch, readBatchSummary } = load(
  "./src/batch.js",
) as typeof import("../src/composition/batch.js");
const { createFmcad } = load(
  "./src/dist/composition/library.js",
) as typeof import("../src/composition/library.js");
const { id, resolveFmcadConfiguration } = load(
  "./src/dist/core/index.js",
) as typeof import("../packages/core/src/index.js");
const { execute: executeCommand } = load("./src/cad-service.js") as {
  execute(
    request: { payload: CadWorkerInvocation },
    client: NativeActionClient | null,
    outcome: (value: unknown) => void,
    io: {
      stdout: { write(text: string): void };
      stderr: { write(text: string): void };
    },
  ): Promise<number>;
};
const parseOutput = (text: string) =>
  JSON.parse(text) as BatchReport & {
    state?: string;
    mutation?: boolean;
    historical?: boolean;
    modelValidated?: boolean;
  };
async function directory(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fmcad-summary-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const request = (reportPath: string) => ({
  runId: "summary",
  atomic: false,
  reportPath,
  operations: [
    { id: "first", operation: "entity.list", data: {}, onExisting: "reuse" },
    {
      id: "second",
      operation: "entity.inspect",
      data: { ref: { $ref: "first.result.entity" } },
      onExisting: "reuse",
    },
  ],
});
const context = {
  doc: "Model",
  component: null,
  projectId: null,
  preview: false,
  docId: "pin",
  docFileId: "file-pin",
};
const output = {
  success: true,
  result: { entity: { token: "preserved-ref" }, extra: ["full-output"] },
};
async function cli(args: string[], live = false) {
  let stdout = "",
    stderr = "",
    calls = 0;
  let sessions = 0,
    disposed = 0;
  const code = await main(args, {
    loadConfig: () => {
      assert.ok(live, "config accessed");
      return {
        cfg: resolveFmcadConfiguration({
          adapter: {
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
          environment: {},
          file: {},
          platformDefaults: {},
          acceptedService: null,
        }),
      };
    },
    createFmcad(options) {
      assert.equal(options.config.routing, "queue");
      sessions++;
      const services = createFmcad(options);
      let started = false;
      const client: NativeActionClient = {
        async callTool() {
          calls++;
          return { text: "FMCAD_RESULT " + JSON.stringify(output) };
        },
      };
      return {
        ...services,
        async start() {
          started = true;
        },
        async dispose() {
          disposed++;
          await services.dispose();
        },
        async execute(value, execution) {
          assert.ok(value.kind === "cad-command");
          assert.ok(execution.requestId);
          let observed: unknown;
          let commandStdout = "",
            commandStderr = "";
          const commandCode = await executeCommand(
            { payload: value },
            started ? client : null,
            (result) => {
              observed = result;
            },
            {
              stdout: {
                write(text) {
                  commandStdout += text;
                },
              },
              stderr: {
                write(text) {
                  commandStderr += text;
                },
              },
            },
          );
          assert.notEqual(observed, undefined);
          const result = JSON.parse(JSON.stringify(observed)) as JsonValue;
          assert.ok(
            result && typeof result === "object" && !Array.isArray(result),
          );
          return {
            version: 1,
            requestId: execution.requestId,
            jobId: started ? "batch-job" : null,
            state: started
              ? commandCode === 0
                ? "succeeded"
                : "failed"
              : "local",
            result,
            output: { stdout: commandStdout, stderr: commandStderr },
            outcome: {
              // A batch report's version is its journal schema, not an outcome DTO.
              version: 1,
              acceptance: "accepted",
              executionOutcome: commandCode === 0 ? "succeeded" : "failed",
              mayHaveMutated: null,
              validation: {
                status: "not_checked",
                source: null,
                artifactId: null,
                measurements: {},
              },
              code: null,
              requestId: id("request", execution.requestId),
              jobId: started ? id("job", "batch-job") : null,
            },
          };
        },
      };
    },
    stdout: {
      write: (s) => {
        stdout += s;
      },
    },
    stderr: {
      write: (s) => {
        stderr += s;
      },
    },
    setExitCode() {},
  });
  assert.equal(disposed, sessions);
  return { code, stdout, stderr, calls };
}
async function snapshots(dir: string) {
  return Promise.all(
    (await fs.readdir(dir))
      .sort()
      .map(async (name) => [
        name,
        await fs.readFile(path.join(dir, name), "utf8"),
      ]),
  );
}

test("summary selects documented scalar facts without copying geometry or metadata", async (t) => {
  const dir = await directory(t);
  await runBatch(
    null,
    request(dir),
    context,
    async () => ({
      ...output,
      result: {
        ...output.result,
        value: 12,
        units: "mm",
        count: 0,
        healthy: true,
        metadata: { passed: false },
        geometry: "x".repeat(10000),
      },
    }),
    catalog,
  );
  const before = await snapshots(dir);
  const summary = await readBatchSummary({ reportPath: dir });
  for (const step of summary.steps)
    assert.deepEqual(step.result, {
      value: 12,
      units: "mm",
      count: 0,
      healthy: true,
    });
  assert.deepEqual(await snapshots(dir), before);
});

test("summary preview validates input without reading even a missing report directory", async (t) => {
  const dir = path.join(await directory(t), "not-created");
  const result = await cli([
    "batch",
    "summary",
    "--report-path",
    dir,
    "--preview",
    "--json",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parseOutput(result.stdout).state, "input-validated-only");
  assert.equal(parseOutput(result.stdout).mutation, false);
  assert.deepEqual(await fs.readdir(path.dirname(dir)), []);
});

test("run TEXT formatting leaves full JSON, snapshots, references and full-context replay hashes unchanged", async (t) => {
  const dir = await directory(t);
  const args = [
    "batch",
    "run",
    "--doc",
    "Model",
    "--doc-id",
    "pin",
    "--doc-file-id",
    "file-pin",
    "--data",
    JSON.stringify(request(dir)),
  ];
  const first = await cli([...args, "--summary", "--json"], true);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.calls, 2);
  const report = parseOutput(first.stdout);
  // The typed invocation omits absent optional selectors. Exact document pins
  // and the persisted request/context hash must still survive every replay.
  const invocationContext = {
    doc: "Model",
    preview: false,
    docId: "pin",
    docFileId: "file-pin",
  };
  assert.deepEqual(report.context, invocationContext);
  assert.deepEqual(
    (report.steps[1]!.request!.data as { ref: unknown }).ref,
    output.result.entity,
  );
  assert.deepEqual(report.steps[0]!.output, output);
  const before = await snapshots(dir);
  const plain = await cli([...args, "--json"], true);
  const formattedJson = await cli([...args, "--summary", "--json"], true);
  assert.equal(formattedJson.stdout, plain.stdout);
  assert.equal(parseOutput(plain.stdout).requestHash, report.requestHash);
  const text = await cli([...args, "--summary"], true);
  assert.equal(text.calls, 0);
  assert.match(text.stdout, /Historical reported outcome/);
  assert.match(text.stdout, /status=success runId="summary" reportPath=/);
  assert.match(text.stdout, /step=2 id="second" status=success/);
  assert.doesNotMatch(text.stdout, /preserved-ref|full-output/);
  assert.deepEqual(await snapshots(dir), before);
  const summary = await cli([
    "batch",
    "summary",
    "--report-path",
    dir,
    "--step",
    "2",
    "--json",
  ]);
  assert.equal(summary.code, 0, summary.stderr);
  assert.deepEqual(parseOutput(summary.stdout).steps, [
    { step: 2, id: "second", status: "success" },
  ]);
});

test("a legacy null-selector report remains readable through the typed CLI without resubmission", async (t) => {
  const dir = await directory(t);
  const saved = await runBatch(
    null,
    request(dir),
    context,
    async () => output,
    catalog,
  );
  const before = await snapshots(dir);
  const result = await cli(
    [
      "batch",
      "run",
      "--doc",
      "Model",
      "--doc-id",
      "pin",
      "--doc-file-id",
      "file-pin",
      "--data",
      JSON.stringify(request(dir)),
      "--json",
    ],
    true,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(parseOutput(result.stdout), { ...saved, replayed: true });
  assert.equal(result.calls, 0);
  assert.deepEqual(await snapshots(dir), before);
});

test("reader uses latest numbered report, retains failed/unknown/running outcomes and ignores stale locks/temp files", async (t) => {
  for (const outcome of ["failed", "unknown", "running"]) {
    const dir = await directory(t);
    const report = await runBatch(
      null,
      request(dir),
      context,
      async () => {
        if (outcome === "unknown") throw new Error("timed out");
        return { success: false, result: { partial: true } };
      },
      catalog,
    );
    if (outcome === "running") await fs.unlink(path.join(dir, "00000002.json"));
    await fs.writeFile(path.join(dir, "run.lock"), "stale");
    await fs.writeFile(path.join(dir, ".incomplete.tmp"), "{");
    const before = await snapshots(dir);
    const result = await cli([
      "batch",
      "summary",
      "--report-path",
      dir,
      "--json",
    ]);
    assert.equal(result.code, 1, result.stderr);
    const summary = parseOutput(result.stdout);
    assert.equal(summary.status, outcome);
    assert.equal(summary.success, false);
    assert.equal(summary.historical, true);
    assert.equal(summary.modelValidated, false);
    assert.equal(
      summary.sequence,
      outcome === "running" ? 1 : report["sequence"],
    );
    if (outcome !== "running")
      assert.deepEqual(
        summary.steps[0]!.error,
        (report["steps"] as BatchReport["steps"])[0]!.error,
      );
    assert.equal(
      summary.steps[1]!.status,
      outcome === "running" ? "pending" : "skipped",
    );
    assert.deepEqual(await snapshots(dir), before);
  }
});

test("missing, corrupt and incomplete reports and invalid steps fail locally before config", async (t) => {
  const dir = await directory(t);
  for (const args of [
    [],
    ["--report-path", path.join(dir, "absent")],
    ["--report-path", dir],
  ]) {
    const result = await cli(["batch", "summary", ...args]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Missing CAD inputs|ENOENT|Missing numbered/);
    assert.equal(result.stdout, "");
  }
  await runBatch(null, request(dir), context, async () => output, catalog);
  for (const step of ["0", "-1", "3", "1.5", "null", "no"]) {
    const result = await cli([
      "batch",
      "summary",
      "--report-path",
      dir,
      "--step",
      step,
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /1-based|out of range/);
  }
  const latest = path.join(dir, "00000004.json");
  const saved = await fs.readFile(latest, "utf8");
  for (const corrupt of [
    "{",
    "{}",
    JSON.stringify({ ...parseOutput(saved), steps: [] }),
    JSON.stringify({ ...parseOutput(saved), requestHash: "bad" }),
  ]) {
    await fs.writeFile(latest, corrupt);
    const result = await cli(["batch", "summary", "--report-path", dir]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Corrupt batch report/);
    assert.equal(result.stdout, "");
  }
  await fs.writeFile(latest, saved);
  await fs.unlink(path.join(dir, "00000001.json"));
  await assert.rejects(
    readBatchSummary({ reportPath: dir }),
    /Incomplete report history/,
  );
});

test("corrupt report parser diagnostics omit opaque snippets and leave reports untouched", async (t) => {
  const dir = await directory(t);
  const file = path.join(dir, "00000000.json");
  for (const text of [
    "opaque-unlabeled-fragment",
    '{"value":"opaque-\\"tail"oops}',
    "{opaque-private-property:1}",
    '{\n"value": 1\n"other": 2}',
  ]) {
    await fs.writeFile(file, text);
    const before = await snapshots(dir);
    await assert.rejects(readBatchSummary({ reportPath: dir }), (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /^Corrupt batch report 00000000\.json: Invalid JSON(?: at position \d+)?(?: \(line \d+ column \d+\))?$/,
      );
      return true;
    });
    const result = await cli(["batch", "summary", "--report-path", dir]);
    assert.equal(result.code, 1);
    assert.equal(result.calls, 0);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^ERROR Corrupt batch report 00000000\.json: Invalid JSON/,
    );
    assert.doesNotMatch(
      result.stderr,
      /opaque|unlabeled|private|property|tail|value|other/,
    );
    assert.deepEqual(await snapshots(dir), before);
  }
});

test("corrupt report wrapper preserves genuine schema and filesystem errors", async (t) => {
  const dir = await directory(t);
  const file = path.join(dir, "00000000.json");
  await fs.writeFile(file, "{}");
  await assert.rejects(readBatchSummary({ reportPath: dir }), {
    message:
      "Corrupt batch report 00000000.json: Invalid version-1 report schema or request/context hash",
  });
  await fs.unlink(file);
  await fs.mkdir(file);
  await assert.rejects(
    readBatchSummary({ reportPath: dir }),
    /Corrupt batch report 00000000\.json: EISDIR/,
  );
});

test("summary boolean is exclusive to batch.run; help/catalog describe local historical contract", async () => {
  for (const entry of commands.filter(
    (entry) => entry.kind === "cad" && !catalog[entry.target]?.summaryFlag,
  )) {
    const result = await cli([...entry.key.split(" "), "--summary"]);
    assert.equal(result.code, 1, entry.key);
    assert.match(result.stderr, /Unknown CAD option: --summary/, entry.key);
  }
  const invalid = await cli(["batch", "run", "--summary", "true"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /Unknown CAD option: true/);
  const help = detail("batch", "summary");
  for (const pattern of [
    /1-based/,
    /historical:true/,
    /modelValidated:false/,
    /No --doc/,
    /corrupt/i,
  ])
    assert.match(help, pattern);
  assert.doesNotMatch(help, /--doc is required/);
  assert.match(detail("batch", "run"), /--summary.*TEXT/);
  assert.match(detail("batch"), /batch summary/);
});
