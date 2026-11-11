const { createRequire } =
  require("node:module") as typeof import("node:module");
const { spawnSync } =
  require("node:child_process") as typeof import("node:child_process");
const { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } =
  require("node:fs") as typeof import("node:fs");
const { resolve, join } = require("node:path") as typeof import("node:path");
const { performance } =
  require("node:perf_hooks") as typeof import("node:perf_hooks");
const { pathToFileURL } = require("node:url") as typeof import("node:url");
const { isDeepStrictEqual } =
  require("node:util") as typeof import("node:util");
const { createHash } = require("node:crypto") as typeof import("node:crypto");
const { tmpdir } = require("node:os") as typeof import("node:os");

export interface Observation {
  id: string;
  dto: unknown;
  sdkCalls: number;
  effects: unknown[];
  artifacts: Record<string, string>;
}
export interface Snapshot {
  version: 1;
  observations: Observation[];
}
export interface Allowance {
  id: string;
  field: "dto" | "effects" | "artifacts";
  before: unknown;
  after: unknown;
  reason: string;
}

// No recursive key filtering, path replacement, error rewriting or unknown coercion.
// Adapters must return deterministic synthetic values, or explicitly expose clock/UUID
// fields separately; all fields in this contract are compared exactly.
function compare(
  before: Snapshot,
  after: Snapshot,
  allowances: Allowance[] = [],
) {
  const regressions: string[] = [],
    intentional: string[] = [];
  const used = new Set<Allowance>();
  if (before.version !== 1 || after.version !== 1)
    regressions.push("unsupported snapshot version");
  for (const snapshot of [before, after]) {
    const ids = snapshot.observations.map((x) => x.id);
    if (new Set(ids).size !== ids.length)
      regressions.push("duplicate observation id");
  }
  for (const id of new Set(
    [...before.observations, ...after.observations].map((x) => x.id),
  )) {
    const a = before.observations.find((x) => x.id === id),
      b = after.observations.find((x) => x.id === id);
    if (!a || !b) {
      regressions.push(`${id}: missing observation`);
      continue;
    }
    for (const field of ["dto", "sdkCalls", "effects", "artifacts"] as const) {
      if (isDeepStrictEqual(a[field], b[field])) continue;
      const allowance = allowances.find(
        (x) =>
          field !== "sdkCalls" &&
          x.id === id &&
          x.field === field &&
          x.reason.trim() &&
          isDeepStrictEqual(x.before, a[field]) &&
          isDeepStrictEqual(x.after, b[field]),
      );
      if (allowance) {
        used.add(allowance);
        intentional.push(`${id}.${field}: ${allowance.reason}`);
      } else regressions.push(`${id}.${field}`);
    }
  }
  for (const allowance of allowances)
    if (!used.has(allowance))
      regressions.push(`${allowance.id}: stale allowance`);
  return {
    status: regressions.length ? "fail" : "pass",
    regressions,
    intentional,
  };
}

async function capture(root: string): Promise<Snapshot> {
  const digest = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  const require = createRequire(join(resolve(root), "package.json"));
  const { main } = require("./src/cli");
  const { executeCad, buildCadScript } = require("./src/cad");
  const { buildRunScript } = require("./src/run");
  const { validateBatch, runBatch } = require("./src/batch");
  const { catalog } = require("./src/cad");
  const { failedOutcome } = require("./src/outcome");
  const { responseMessages } = require("./src/mcp-stdio");
  const { scriptConfig } = require("./tests/helpers/legacy");
  const observations: Observation[] = [];
  const pins = {
    doc: "Synthetic Model",
    docId: "creation-fixture",
    docFileId: "urn:fixture:file",
    projectId: "project-fixture",
  };
  const script = buildCadScript("status", {}, pins);
  const request = scriptConfig(script, ["_FMCAD_REQUEST"])._FMCAD_REQUEST;
  observations.push({
    id: "cad.prepare",
    dto: request,
    sdkCalls: 0,
    effects: [],
    artifacts: { "status.py": digest(script) },
  });
  for (const [id, operation, reply] of [
    [
      "cad.status",
      "status",
      { success: true, result: { document: pins, bodies: [] } },
    ],
    [
      "documents.status",
      "document.status",
      {
        success: true,
        result: { document: pins, isModified: false, isSaved: true },
      },
    ],
    [
      "safety.document-changed",
      "status",
      {
        success: false,
        status: "blocked",
        error: "DOCUMENT_CHANGED",
        result: { document: { ...pins, docId: "different-creation" } },
      },
    ],
    [
      "observation.unknown",
      "status",
      {
        success: false,
        status: "unknown",
        error: "ack lost; do not replay",
        result: { document: pins },
      },
    ],
  ] as const) {
    const effects: unknown[] = [];
    const client = {
      async callTool(args: any) {
        effects.push({
          kind: "sdk",
          request: scriptConfig(args.object.script, ["_FMCAD_REQUEST"])
            ._FMCAD_REQUEST,
        });
        return { text: `FMCAD_RESULT ${JSON.stringify(reply)}` };
      },
    };
    const dto = await executeCad(client, operation, {}, pins);
    observations.push({
      id,
      dto,
      sdkCalls: effects.length,
      effects,
      artifacts: {},
    });
  }
  for (const [id, args] of [
    ["cli.help", ["--help"]],
    [
      "safety.duplicate-pin",
      ["cad", "status", "--doc", pins.doc, "--doc-id", "a", "--doc-id", "b"],
    ],
    ["safety.invalid-input", ["cad", "status", "--data", "{broken"]],
  ] as const) {
    let stdout = "",
      stderr = "",
      configReads = 0;
    const code = await main([...args], {
      loadConfig() {
        configReads++;
        throw new Error("unexpected configuration read");
      },
      stdout: {
        write(s: string) {
          stdout += s;
        },
      },
      stderr: {
        write(s: string) {
          stderr += s;
        },
      },
      setExitCode() {},
    });
    if (id === "cli.help" && code !== 0)
      throw new Error(`help failed: ${stderr}`);
    observations.push({
      id,
      dto: { code, stdout, stderr },
      sdkCalls: 0,
      effects: [{ configReads }],
      artifacts: {},
    });
  }
  observations.push({
    id: "batch.validate",
    dto: validateBatch(
      {
        runId: "fixture",
        operations: [
          { id: "one", operation: "status", data: {} },
          { id: "two", operation: "status", data: {}, component: "Part" },
        ],
      },
      catalog,
    ),
    sdkCalls: 0,
    effects: [],
    artifacts: {},
  });
  observations.push({
    id: "mcp.response",
    dto: responseMessages(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "synthetic" }] },
      }),
    ),
    sdkCalls: 0,
    effects: [],
    artifacts: {},
  });
  observations.push({
    id: "safety.unknown-outcome",
    dto: { failed: failedOutcome({ status: "unknown" }) },
    sdkCalls: 0,
    effects: [],
    artifacts: {},
  });
  const directory = mkdtempSync(join(tmpdir(), "fmcad-refactor-baseline-"));
  try {
    const file = join(directory, "fixture.py");
    writeFileSync(
      file,
      'ARGS = {}\nDOC_NAME = ""\ndef run(context):\n    pass\n',
      { flag: "wx" },
    );
    observations.push({
      id: "run.prepare",
      dto: { args: { unicode: "Zażółć 🐈", safe: "$&" }, doc: pins.doc },
      sdkCalls: 0,
      effects: [],
      artifacts: {
        "run.py": digest(
          buildRunScript(
            file,
            { unicode: "Zażółć 🐈", safe: "$&" },
            true,
            pins.doc,
          ),
        ),
      },
    });
    const effects: unknown[] = [];
    let stdout = "",
      stderr = "";
    const backend = {
      async callTool(request: any) {
        effects.push({
          featureType: request.featureType,
          readOnly: request.object.readOnly,
          scriptSha256: digest(request.object.script),
        });
        return { text: "SYNTHETIC_RUN_COMPLETE" };
      },
    };
    const io = {
      stdout: {
        write(s: string) {
          stdout += s;
        },
      },
      stderr: {
        write(s: string) {
          stderr += s;
        },
      },
    };
    // The refactor moved execution behind a typed worker service. Keep the
    // physical boundary fake, but execute the real service and generated program.
    // Historical checkouts still use their original CLI injection point.
    let code: number;
    if (require("node:fs").existsSync(join(root, "src/cad-service.js"))) {
      const service = require("./src/cad-service");
      const request = service.fromParsedCommand({
        kind: "run",
        request: {
          name: file,
          args: {},
          hasArgs: false,
          doc: pins.doc,
          identity: { readOnly: true },
        },
      });
      code = await service.execute(request, backend, undefined, io);
    } else {
      code = await main(["run", file, "--doc", pins.doc, "--readonly"], {
        loadConfig: () => ({ cfg: { backend: "mcp" } }),
        McpClient: class {
          callTool = backend.callTool;
        },
        ...io,
        setExitCode() {},
      });
    }
    observations.push({
      id: "run.execute",
      dto: { code, stdout, stderr },
      sdkCalls: effects.length,
      effects,
      artifacts: {},
    });

    // Compare the semantic batch report separately from its environment-specific storage locator
    // and clock telemetry. No scope, output, failure or unknown field is rewritten.
    const semanticReport = (report: any) =>
      Object.fromEntries(
        Object.entries(report).filter(
          ([key]) =>
            !["reportPath", "createdAt", "updatedAt", "elapsedMs"].includes(
              key,
            ),
        ),
      );
    for (const unknown of [false, true]) {
      const batchEffects: unknown[] = [];
      const reportPath = join(directory, unknown ? "unknown" : "success");
      const data = {
        runId: "fixture",
        reportPath,
        operations: [
          { id: "one", operation: "status", data: {}, onExisting: "reuse" },
          {
            id: "two",
            operation: "status",
            data: {},
            component: "Part",
            onExisting: "reuse",
          },
        ],
      };
      const client = {
        async callTool(args: any) {
          batchEffects.push({
            kind: "sdk",
            request: scriptConfig(args.object.script, ["_FMCAD_REQUEST"])
              ._FMCAD_REQUEST,
          });
          return {
            text:
              "FMCAD_RESULT " +
              JSON.stringify(
                unknown
                  ? {
                      success: false,
                      status: "unknown",
                      error: "ack lost; do not replay",
                    }
                  : { success: true, result: { document: pins } },
              ),
          };
        },
      };
      const report = await runBatch(client, data, pins, executeCad, catalog);
      let replay: unknown;
      try {
        replay = semanticReport(
          await runBatch(client, data, pins, executeCad, catalog),
        );
      } catch (error) {
        replay = { error: (error as Error).message };
      }
      const files = readdirSync(reportPath).sort();
      const persisted = JSON.parse(
        readFileSync(join(reportPath, files.at(-1)!), "utf8"),
      );
      if (
        !isDeepStrictEqual(
          semanticReport(persisted),
          semanticReport(JSON.parse(JSON.stringify(report))),
        )
      ) {
        throw new Error(
          "Persisted batch semantics differ from returned report",
        );
      }
      observations.push({
        id: unknown ? "batch.unknown-no-replay" : "batch.execute-replay",
        dto: { report: semanticReport(report), replay },
        sdkCalls: batchEffects.length,
        effects: batchEffects,
        artifacts: { "report-manifest": JSON.stringify(files) },
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // DTOs cross a JSON boundary: absent optional properties are not JS undefined values.
  return JSON.parse(JSON.stringify({ version: 1, observations }));
}

function command(
  command: string,
  args: string[],
  cwd: string,
  timeout = 0,
  input?: string,
  env?: NodeJS.ProcessEnv,
) {
  const start = performance.now();
  const result = spawnSync(command, args, {
    cwd,
    timeout,
    encoding: "utf8",
    input,
    ...(env ? { env } : {}),
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    processCount: 1,
    status:
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
        ? "timeout"
        : result.error
          ? "error"
          : result.status === 0
            ? "pass"
            : "fail",
    exitCode: result.status,
    signal: result.signal,
    elapsedMs: performance.now() - start,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message,
  };
}

async function main() {
  const [mode, root = ".", output, other] = process.argv.slice(2);
  if (mode === "capture") {
    if (!output) throw new Error("capture ROOT OUTPUT");
    writeFileSync(
      output,
      JSON.stringify(await capture(resolve(root)), null, 2) + "\n",
    );
  } else if (mode === "compare") {
    if (!output) throw new Error("compare BEFORE AFTER [ALLOWANCES]");
    const result = compare(
      JSON.parse(readFileSync(root, "utf8")),
      JSON.parse(readFileSync(output, "utf8")),
      other ? JSON.parse(readFileSync(other, "utf8")) : [],
    );
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "pass" ? 0 : 1;
  } else if (mode === "adapter") {
    if (!output || !other) throw new Error("adapter ROOT OUTPUT MODULE");
    const adapter = await import(pathToFileURL(resolve(other)).href);
    writeFileSync(
      output,
      JSON.stringify(await adapter.capture(resolve(root)), null, 2) + "\n",
    );
  } else throw new Error("Expected capture, compare or adapter");
}
export type Harness = {
  capture: typeof capture;
  compare: typeof compare;
  command: typeof command;
};
module.exports = { capture, compare, command } satisfies Harness;
if (require.main === module)
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
