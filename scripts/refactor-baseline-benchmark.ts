/* eslint-disable @typescript-eslint/no-require-imports -- The benchmark keeps CommonJS loading so child-process instrumentation observes the same module instances as historical workers. */
const data =
  require("./refactor-benchmark-data.ts") as typeof import("./refactor-benchmark-data");
import type {
  Run,
  Workload,
  Sample,
  Report,
  Fields,
  FinalRuntime,
} from "./refactor-benchmark-data";

const { createRequire } =
  require("node:module") as typeof import("node:module");
const {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  existsSync,
} = require("node:fs") as typeof import("node:fs");
const { resolve, join, dirname, isAbsolute, relative, sep } =
  require("node:path") as typeof import("node:path");
const { cpus, release, platform, tmpdir } =
  require("node:os") as typeof import("node:os");
const { spawn } =
  require("node:child_process") as typeof import("node:child_process");
const { createHash } = require("node:crypto") as typeof import("node:crypto");
const { performance } =
  require("node:perf_hooks") as typeof import("node:perf_hooks");
const { PassThrough } = require("node:stream") as typeof import("node:stream");
const { command } =
  require("./refactor-baseline.ts") as import("./refactor-baseline").Harness;
const fixtureInput = data.record(
  data.json(
    readFileSync(
      join(__dirname, "../tests/fixtures/refactor-final-benchmark.json"),
      "utf8",
    ),
  ),
);
const fixtureConfig = data.record(fixtureInput["config"]);
const fixture = {
  ...fixtureInput,
  nodeEnv: data.text(fixtureInput["nodeEnv"]),
  samples: data.number(fixtureInput["samples"]),
  warmIterations: data.number(fixtureInput["warmIterations"]),
  clients: data.number(fixtureInput["clients"]),
  protocolVersion: data.text(fixtureInput["protocolVersion"]),
  config: {
    ...fixtureConfig,
    backend: data.text(fixtureConfig["backend"]),
    routing: data.text(fixtureConfig["routing"]),
    timeoutMs: data.number(fixtureConfig["timeoutMs"]),
    queueAutoStart: fixtureConfig["queueAutoStart"],
  },
};
function moduleFunction(
  root: string,
  module: string,
  name: string,
): (...args: unknown[]) => unknown {
  const exports = data.record(
    createRequire(join(root, "package.json"))(module),
  );
  const fn = exports[name];
  if (typeof fn !== "function")
    throw new TypeError(`Missing ${module}.${name}`);
  return (...args) => Reflect.apply(fn, exports, args);
}
export type BenchmarkWorker =
  "import" | "help" | "prepare-bundle" | "mcp-startup";

type FinalWorkload =
  "api-import" | "help" | "mcp" | "catalog" | "prepare-bundle" | "multi-client";

const token = "f".repeat(64);
const baselineSource = "a341f6fd2672f9537d9ed5b865d1f2f07de1b099";
const fakeQueueSummary = {
  version: 1,
  revision: 0,
  epoch: 0,
  paused: false,
  blocked: null,
  active: null,
  lease: null,
  jobCount: 0,
  stateCounts: {},
  nonterminalJobCount: 0,
  control: { phase: "IDLE", activeOperations: 0 },
  held: false,
  stopping: false,
  recovery: null,
  buildHash: "fixture-only",
  features: {
    conditionalIdleStop: true,
    phasedCommands: true,
    atomicWorkflowObserve: true,
    atomicRecoveryAudit: true,
  },
};

function isolatedEnvironment(directory: string): NodeJS.ProcessEnv {
  const values = {
    HOME: join(directory, "home"),
    TMPDIR: join(directory, "tmp"),
    TMP: join(directory, "tmp"),
    TEMP: join(directory, "tmp"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_CACHE_HOME: join(directory, "cache"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_STATE_HOME: join(directory, "state"),
  };
  for (const path of Object.values(values))
    mkdirSync(path, { recursive: true });
  return {
    PATH: process.env["PATH"] ?? "",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    NODE_ENV: fixture.nodeEnv,
    ...(process.env["WSL_DISTRO_NAME"]
      ? { WSL_DISTRO_NAME: process.env["WSL_DISTRO_NAME"] }
      : {}),
    ...values,
  };
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

function summarizeSamples(values: readonly unknown[]) {
  if (
    !values.length ||
    values.some((value) => typeof value !== "number" || !Number.isFinite(value))
  )
    return null;
  const sorted = values
    .map((value) => {
      if (typeof value !== "number") throw new TypeError("Invalid measurement");
      return value;
    })
    .sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!;
  const p95Index = Math.ceil(sorted.length * 0.95) - 1;
  return {
    count: sorted.length,
    min: sorted[0],
    median,
    p95: sorted[p95Index],
    max: sorted.at(-1),
    spread: sorted.at(-1)! - sorted[0]!,
  };
}

function isCompleteFinalRuntime(value: unknown): boolean {
  let runtime: FinalRuntime;
  try {
    runtime = data.finalRuntime(value);
  } catch {
    return false;
  }
  const names = [
    "api-import",
    "help",
    "mcp",
    "catalog",
    "prepare-bundle",
    "multi-client",
  ];
  if (
    runtime?.version !== 1 ||
    typeof runtime.fixtureSha256 !== "string" ||
    runtime.isolation?.["rootUnderOsTemp"] !== true ||
    runtime.isolation?.["uniqueOwnedSubdirectories"] !== true ||
    runtime.isolation?.["xdgRootsPerClient"] !== true ||
    runtime.isolation?.["noGlobalBrokerOrSdk"] !== true ||
    !names.every((name) => runtime.workloads?.[name])
  )
    return false;
  return names.every((name) => {
    const workload = runtime.workloads[name];
    if (!workload) return false;
    if (
      workload.coldRuns?.length !== fixture.samples ||
      workload.warmRuns?.length !== fixture.samples
    )
      return false;
    const passed = [...workload.coldRuns, ...workload.warmRuns].every(
      (run: Run) => {
        if (run.status !== "pass" || !run.data) return false;
        if (!run.data.clients) {
          if (
            run.processCount !== 1 ||
            run.data.processCount !== 1 ||
            run.data.childProcessLaunchCalls !== 0
          )
            return false;
          return (
            name !== "api-import" ||
            (run.data.first?.processLaunchCalls === 0 &&
              run.data.first?.newActiveResources?.length === 0 &&
              run.data.first?.newActiveHandles?.length === 0)
          );
        }
        const phase = workload.coldRuns.includes(run) ? "cold" : "warm";
        const expectedStatusCalls =
          phase === "cold" ? 1 : fixture.warmIterations + 1;
        return (
          run.data.status === "pass" &&
          run.data.clients.length === fixture.clients &&
          run.data.clients.every(
            (client: Run) =>
              client.status === "pass" &&
              client.data?.processCount === 1 &&
              client.data?.childProcessLaunchCalls === 0 &&
              client.data?.first?.fakeQueue?.registerCalls === 1 &&
              client.data.first.fakeQueue.queueSummaryCalls ===
                expectedStatusCalls &&
              client.data?.warmSamples?.length ===
                (phase === "cold" ? 0 : fixture.warmIterations),
          ) &&
          run.processCount === 1 &&
          run.data.processCount === fixture.clients &&
          run.data.fakeQueue?.registerCalls === fixture.clients &&
          run.data.fakeQueue?.queueSummaryCalls ===
            fixture.clients * expectedStatusCalls
        );
      },
    );
    return passed;
  });
}

function commandAsync(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  env: NodeJS.ProcessEnv,
) {
  const started = performance.now();
  return new Promise<{
    processCount: number;
    status: string;
    elapsedMs: number;
    stdout: string;
    stderr: string;
    error?: string;
    exitCode?: number | null;
    signal?: string | null;
  }>((resolveResult) => {
    let stdout = "",
      stderr = "",
      timedOut = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error: Error) => {
      clearTimeout(timer);
      resolveResult({
        processCount: 1,
        status: "error",
        elapsedMs: performance.now() - started,
        stdout,
        stderr,
        error: error.message,
      });
    });
    child.once("close", (exitCode: number | null, signal: string | null) => {
      clearTimeout(timer);
      resolveResult({
        processCount: 1,
        status: timedOut ? "timeout" : exitCode === 0 ? "pass" : "fail",
        exitCode,
        signal,
        elapsedMs: performance.now() - started,
        stdout,
        stderr,
      });
    });
  });
}

async function runHelp(root: string) {
  let output = "";
  const started = performance.now();
  const code = await moduleFunction(
    root,
    "./src/cli",
    "main",
  )(["--help"], {
    stdout: {
      write(text: string) {
        output += text;
      },
    },
    stderr: {
      write(text: string) {
        throw new Error(text);
      },
    },
    setExitCode() {},
    loadConfig() {
      throw new Error("help touched configuration");
    },
  });
  if (code !== 0 || !output)
    throw new Error(`offline CLI help failed with exit ${code}`);
  return {
    operationMs: performance.now() - started,
    outputBytes: Buffer.byteLength(output),
  };
}

async function runBundle(root: string) {
  const started = performance.now();
  const buildCadScript = moduleFunction(root, "./src/cad", "buildCadScript");
  const script = data.text(
    buildCadScript(
      "status",
      {},
      {
        doc: "Synthetic Model",
        docId: "creation-fixture",
        docFileId: "urn:fixture:file",
        projectId: "project-fixture",
      },
    ),
  );
  return {
    operationMs: performance.now() - started,
    bytes: Buffer.byteLength(script),
    sha256: createHash("sha256").update(script).digest("hex"),
  };
}

async function runApiImport(root: string) {
  const childProcess = data.record(require("node:child_process"));
  const names = [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ];
  const originals = new Map<string, unknown>();
  let processLaunchCalls = 0;
  for (const name of names) {
    const original = childProcess[name];
    if (typeof original !== "function")
      throw new TypeError("Missing process launcher " + name);
    originals.set(name, original);
    childProcess[name] = function (this: unknown, ...args: unknown[]) {
      processLaunchCalls++;
      return Reflect.apply(original, this, args);
    };
  }
  const resourceNames = () => process.getActiveResourcesInfo().sort();
  const handleNames = () => {
    if (
      !("_getActiveHandles" in process) ||
      typeof process._getActiveHandles !== "function"
    )
      throw new Error("Node active handle observation unavailable");
    return data
      .array(Reflect.apply(process._getActiveHandles, process, []))
      .map((handle) => {
        if (handle === null || typeof handle !== "object") return "unknown";
        return handle.constructor?.name ?? "unknown";
      })
      .sort();
  };
  const resourcesBefore = resourceNames();
  const handlesBefore = handleNames();
  const started = performance.now();
  let exports: string[];
  try {
    exports = Object.keys(
      data.record(createRequire(join(root, "package.json"))("./src/dist/api")),
    ).sort();
  } finally {
    for (const [name, original] of originals) childProcess[name] = original;
  }
  const operationMs = performance.now() - started;
  const resourcesAfter = resourceNames();
  const handlesAfter = handleNames();
  const difference = (before: string[], after: string[]) => {
    const counts = new Map<string, number>();
    for (const name of before) counts.set(name, (counts.get(name) ?? 0) + 1);
    const added: string[] = [];
    for (const name of after) {
      const count = counts.get(name) ?? 0;
      if (count > 0) counts.set(name, count - 1);
      else added.push(name);
    }
    return added;
  };
  return {
    operationMs,
    exportCount: exports.length,
    exports,
    processLaunchCalls,
    newActiveResources: difference(resourcesBefore, resourcesAfter),
    newActiveHandles: difference(handlesBefore, handlesAfter),
  };
}

async function runMcp(
  root: string,
  kind: "mcp" | "catalog" | "multi-client",
  projectDirectory: string,
  clientId: string,
  warmIterations: number,
) {
  const fakeRpcs: Array<{
    action: string;
    requestBytes: number;
    responseBytes: number;
  }> = [];
  let configReads = 0;
  let stderrText = "";
  let outputBuffer = "";
  let nextId = 0;
  const waiters = new Map<
    string,
    (value: { frame: Fields; frameBytes: number }) => void
  >();
  const input = new PassThrough();
  const output = new PassThrough();
  output.on("data", (chunk: Buffer) => {
    outputBuffer += chunk.toString("utf8");
    for (;;) {
      const newline = outputBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = outputBuffer.slice(0, newline);
      outputBuffer = outputBuffer.slice(newline + 1);
      const frame = data.record(data.json(line));
      if (frame["id"] !== undefined) {
        const waiter = waiters.get(String(frame["id"]));
        if (waiter) {
          waiters.delete(String(frame["id"]));
          waiter({ frame, frameBytes: Buffer.byteLength(line) + 1 });
        }
      }
    }
  });

  class FakeQueueClient {
    auth: { clientId: string; clientToken: string };

    constructor(id: string) {
      this.auth = { clientId: id, clientToken: token };
    }

    private record(action: string, request: unknown, result: unknown) {
      fakeRpcs.push({
        action,
        requestBytes: Buffer.byteLength(JSON.stringify(request) + "\n"),
        responseBytes: Buffer.byteLength(
          JSON.stringify({ ok: true, result }) + "\n",
        ),
      });
    }

    async register() {
      const result = { clientId: this.auth.clientId };
      this.record("register", { action: "register", ...this.auth }, result);
      return result;
    }

    async call(action: string, values: Record<string, unknown> = {}) {
      if (action !== "queue-summary")
        throw new Error(`unexpected fake queue action: ${action}`);
      this.record(
        action,
        { ...values, action, auth: this.auth },
        fakeQueueSummary,
      );
      return fakeQueueSummary;
    }
  }

  const importStarted = performance.now();
  const startStdio = moduleFunction(root, "./src/mcp-stdio", "startStdio");
  const importMs = performance.now() - importStarted;
  const server = data.record(
    startStdio(
      [
        "--backend",
        "mcp",
        "--routing",
        "queue",
        "--client",
        clientId,
        "--project-directory",
        projectDirectory,
      ],
      {
        loadConfig() {
          configReads++;
          return {
            cfg: {
              backend: fixture.config.backend,
              routing: fixture.config.routing,
              timeoutMs: fixture.config.timeoutMs,
              queue: {
                autoStart: fixture.config.queueAutoStart,
                waitTimeoutMs: 1000,
              },
            },
          };
        },
        QueueClient: FakeQueueClient,
        stdin: input,
        stdout: output,
        stderr: {
          write(text: string) {
            stderrText += text;
          },
        },
      },
    ),
  );
  if (!server) throw new Error("MCP server did not start");

  async function request(method: string, params: Record<string, unknown> = {}) {
    const id = ++nextId;
    const started = performance.now();
    const response = new Promise<{ frame: Fields; frameBytes: number }>(
      (resolve) => waiters.set(String(id), resolve),
    );
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const value = await response;
    if (value.frame["error"])
      throw new Error(
        `${method} returned MCP error: ${JSON.stringify(value.frame["error"])}`,
      );
    return {
      elapsedMs: performance.now() - started,
      frameBytes: value.frameBytes,
      result: data.record(value.frame["result"]),
    };
  }

  const initialize = await request("initialize", {
    protocolVersion: fixture.protocolVersion,
    capabilities: {},
    clientInfo: { name: "fmcad-final-benchmark", version: "1" },
  });
  input.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  type RpcResult = Awaited<ReturnType<typeof request>>;
  let catalogResult: RpcResult | undefined;
  let statusResult: RpcResult | undefined;
  let catalogTools: unknown[] | undefined;
  if (kind !== "mcp") {
    catalogResult = await request("tools/list");
    catalogTools = data.array(catalogResult.result["tools"]);
  }
  if (kind === "multi-client") {
    const tools = catalogTools ?? [];
    if (
      !tools.some((tool) => data.record(tool)["name"] === "fmcad_queue_status")
    )
      throw new Error("queue status helper missing from local catalog");
    statusResult = await request("tools/call", {
      name: "fmcad_queue_status",
      arguments: {},
    });
    if (statusResult.result?.["isError"])
      throw new Error("fake broker status request was rejected");
  }

  const warmSamples: Sample[] = [];
  for (let i = 0; i < warmIterations; i++) {
    if (kind === "mcp") {
      const sample = await request("initialize", {
        protocolVersion: fixture.protocolVersion,
        capabilities: {},
        clientInfo: { name: "fmcad-final-benchmark", version: "1" },
      });
      warmSamples.push({
        operationMs: sample.elapsedMs,
        responseBytes: sample.frameBytes,
      });
    } else {
      const sample = await request("tools/list");
      warmSamples.push({
        operationMs: sample.elapsedMs,
        responseBytes: sample.frameBytes,
      });
      if (kind === "multi-client") {
        const status = await request("tools/call", {
          name: "fmcad_queue_status",
          arguments: {},
        });
        if (status.result?.["isError"])
          throw new Error("warm fake broker status request was rejected");
        const last = warmSamples.at(-1);
        if (!last) throw new Error("Missing warm sample");
        last.fakeRpcOperationMs = status.elapsedMs;
      }
    }
  }
  input.end();
  const settled = data.array(await server["closed"]);
  if (settled.some((result) => data.record(result)["status"] === "rejected"))
    throw new Error("MCP server close rejected");
  if (stderrText) throw new Error(`MCP wrote diagnostics: ${stderrText}`);

  const operationMs =
    kind === "mcp"
      ? initialize.elapsedMs
      : (catalogResult?.elapsedMs ?? 0) + (statusResult?.elapsedMs ?? 0);
  const requests = fakeRpcs.length;
  return {
    operationMs,
    importMs,
    initializeMs: initialize.elapsedMs,
    catalogMs: catalogResult?.elapsedMs ?? null,
    statusMs: statusResult?.elapsedMs ?? null,
    catalogTools: catalogTools?.length ?? null,
    catalogBytes: catalogResult
      ? Buffer.byteLength(JSON.stringify(catalogTools))
      : null,
    catalogFrameBytes: catalogResult?.frameBytes ?? null,
    warmSamples,
    configReads,
    clientId,
    fakeQueue: {
      mode: "injected QueueClient; no broker process or IPC",
      wrapperCalls: requests,
      registerCalls: fakeRpcs.filter((call) => call.action === "register")
        .length,
      queueSummaryCalls: fakeRpcs.filter(
        (call) => call.action === "queue-summary",
      ).length,
      requestBytes: fakeRpcs.reduce((sum, call) => sum + call.requestBytes, 0),
      responseBytes: fakeRpcs.reduce(
        (sum, call) => sum + call.responseBytes,
        0,
      ),
    },
    rssBytes: process.memoryUsage().rss,
    maxRssKiB: process.resourceUsage().maxRSS,
  };
}

async function runFinalWorker(
  root: string,
  kind: FinalWorkload,
  phase: "cold" | "warm",
  projectDirectory: string,
  clientId: string,
  warmIterations: number,
) {
  const started = performance.now();
  let first: Sample;
  let warmSamples: Sample[] = [];
  const childProcess = data.record(require("node:child_process"));
  const processMethods = [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ];
  const processLaunchCounts: Record<string, number> = {};
  const originals = new Map<string, unknown>();
  for (const name of processMethods) {
    const original = childProcess[name];
    if (typeof original !== "function")
      throw new TypeError("Missing process launcher " + name);
    originals.set(name, original);
    processLaunchCounts[name] = 0;
    childProcess[name] = function (this: unknown, ...args: unknown[]) {
      processLaunchCounts[name] = processLaunchCounts[name]! + 1;
      return Reflect.apply(original, this, args);
    };
  }
  try {
    if (kind === "help" || kind === "prepare-bundle" || kind === "api-import") {
      const run =
        kind === "help"
          ? runHelp
          : kind === "prepare-bundle"
            ? runBundle
            : runApiImport;
      first = await run(root);
      if (phase === "warm") {
        for (let i = 0; i < warmIterations; i++)
          warmSamples.push(await run(root));
      }
    } else {
      const mcpFirst = await runMcp(
        root,
        kind,
        projectDirectory,
        clientId,
        phase === "warm" ? warmIterations : 0,
      );
      first = mcpFirst;
      warmSamples = mcpFirst.warmSamples;
    }
  } finally {
    for (const [name, original] of originals) childProcess[name] = original;
  }
  const childProcessLaunchCalls = Object.values(processLaunchCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  return {
    phase,
    kind,
    operationMs: first.operationMs,
    first,
    warmSamples,
    processCount: 1 + childProcessLaunchCalls,
    childProcessLaunchCalls,
    childProcessLaunchCounts: processLaunchCounts,
    rssBytes: process.memoryUsage().rss,
    maxRssKiB: process.resourceUsage().maxRSS,
    elapsedMs: performance.now() - started,
  };
}

async function runMultiClientSample(
  root: string,
  directory: string,
  projectDirectory: string,
  phase: "cold" | "warm",
) {
  const started = performance.now();
  const clients = await Promise.all(
    Array.from({ length: fixture.clients }, async (_, index) => {
      const clientId = `fixture-client-${index + 1}`;
      const clientDirectory = join(directory, `client-${index + 1}`);
      mkdirSync(clientDirectory, { recursive: true });
      const env = isolatedEnvironment(clientDirectory);
      const result = await commandAsync(
        process.execPath,
        [
          "--experimental-strip-types",
          __filename,
          "--final-worker",
          root,
          "multi-client",
          phase,
          projectDirectory,
          clientId,
          String(fixture.warmIterations),
        ],
        root,
        30000,
        env,
      );
      return {
        clientId,
        ...result,
        processCount:
          result.status === "pass"
            ? data.number(
                data.workerData(data.json(result.stdout)).processCount,
              )
            : 0,
        data:
          result.status === "pass"
            ? data.workerData(data.json(result.stdout))
            : null,
        stdout: undefined,
      };
    }),
  );
  const allPass = clients.every((client) => client.status === "pass");
  const rpc = clients.flatMap((client) =>
    client.data?.first?.fakeQueue ? [client.data.first.fakeQueue] : [],
  );
  return {
    status: allPass ? "pass" : "incomplete",
    elapsedMs: performance.now() - started,
    processCount: clients.reduce(
      (sum, client) => sum + (client.data?.processCount ?? client.processCount),
      0,
    ),
    clients,
    fakeQueue: {
      mode: "injected QueueClient; no broker process or IPC",
      wrapperCalls: rpc.reduce(
        (sum, calls) => sum + data.number(calls.wrapperCalls),
        0,
      ),
      registerCalls: rpc.reduce(
        (sum, calls) => sum + data.number(calls.registerCalls),
        0,
      ),
      queueSummaryCalls: rpc.reduce(
        (sum, calls) => sum + data.number(calls.queueSummaryCalls),
        0,
      ),
      requestBytes: rpc.reduce(
        (sum, calls) => sum + data.number(calls.requestBytes),
        0,
      ),
      responseBytes: rpc.reduce(
        (sum, calls) => sum + data.number(calls.responseBytes),
        0,
      ),
    },
  };
}

async function measureFinalRuntime(root: string, directory: string) {
  const finalDirectory = join(directory, "final-runtime");
  mkdirSync(finalDirectory, { recursive: true });
  const workloads: Record<string, Workload> = {};
  for (const kind of [
    "api-import",
    "help",
    "mcp",
    "catalog",
    "prepare-bundle",
  ] as const) {
    workloads[kind] = { coldRuns: [], warmRuns: [] };
    for (const phase of ["cold", "warm"] as const) {
      const runs =
        phase === "cold" ? workloads[kind].coldRuns : workloads[kind].warmRuns;
      for (let sample = 0; sample < fixture.samples; sample++) {
        const sampleDirectory = mkdtempSync(
          join(finalDirectory, `${kind}-${phase}-`),
        );
        const projectDirectory = join(sampleDirectory, "project");
        mkdirSync(projectDirectory);
        const env = isolatedEnvironment(sampleDirectory);
        const clientId = "fixture-single-client";
        const result = command(
          process.execPath,
          [
            "--experimental-strip-types",
            __filename,
            "--final-worker",
            root,
            kind,
            phase,
            projectDirectory,
            clientId,
            String(fixture.warmIterations),
          ],
          root,
          30000,
          undefined,
          env,
        );
        runs.push({
          ...result,
          stdout: undefined,
          data:
            result.status === "pass"
              ? data.workerData(data.json(result.stdout))
              : null,
        });
      }
    }
  }

  workloads["multi-client"] = { coldRuns: [], warmRuns: [] };
  for (const phase of ["cold", "warm"] as const) {
    const runs =
      phase === "cold"
        ? workloads["multi-client"].coldRuns
        : workloads["multi-client"].warmRuns;
    for (let sample = 0; sample < fixture.samples; sample++) {
      const sampleDirectory = mkdtempSync(
        join(finalDirectory, `multi-client-${phase}-`),
      );
      const projectDirectory = join(sampleDirectory, "project");
      mkdirSync(projectDirectory);
      const coordinatorDirectory = join(sampleDirectory, "coordinator");
      const env = isolatedEnvironment(coordinatorDirectory);
      const result = await commandAsync(
        process.execPath,
        [
          "--experimental-strip-types",
          __filename,
          "--multi-worker",
          root,
          sampleDirectory,
          projectDirectory,
          phase,
        ],
        root,
        60000,
        env,
      );
      runs.push({
        ...result,
        stdout: undefined,
        data:
          result.status === "pass"
            ? data.workerData(data.json(result.stdout))
            : null,
      });
    }
  }
  return {
    version: 1,
    fixtureSha256: createHash("sha256")
      .update(JSON.stringify(fixture))
      .digest("hex"),
    fixture,
    isolation: {
      rootUnderOsTemp: isWithin(tmpdir(), finalDirectory),
      uniqueOwnedSubdirectories: true,
      nodeEnv: fixture.nodeEnv,
      xdgRootsPerClient: true,
      noGlobalBrokerOrSdk: true,
    },
    sampleCount: fixture.samples,
    warmIterations: fixture.warmIterations,
    workloads,
  };
}

function paired(
  valuesBefore: readonly unknown[] = [],
  valuesAfter: readonly unknown[] = [],
) {
  const baseline = summarizeSamples(valuesBefore);
  const candidate = summarizeSamples(valuesAfter);
  const compact = (value: ReturnType<typeof summarizeSamples>) =>
    value
      ? {
          n: value.count,
          median: value.median,
          p95: value.p95,
          spread: value.spread,
        }
      : null;
  if (!baseline || !candidate)
    return {
      baseline: compact(baseline),
      candidate: compact(candidate),
      medianDelta: null,
      medianDeltaPercent: null,
    };
  return {
    baseline: compact(baseline),
    candidate: compact(candidate),
    medianDelta: candidate.median! - baseline.median!,
    medianDeltaPercent:
      baseline.median === 0
        ? null
        : ((candidate.median! - baseline.median!) / baseline.median!) * 100,
  };
}

function workloadMetrics(report: Report, name: string) {
  const workload = report.finalRuntime?.workloads?.[name] ?? {
    coldRuns: [],
    warmRuns: [],
  };
  const multi = name === "multi-client";
  const cold = workload.coldRuns;
  const warm = workload.warmRuns;
  const values = (runs: Run[], selector: (run: Run) => unknown[]) =>
    runs.flatMap((run) => selector(run));
  const coldRss = multi
    ? values(cold, (run) =>
        (run.data?.clients ?? []).map((client: Run) => client.data?.rssBytes),
      )
    : cold.map((run: Run) => run.data?.rssBytes);
  const warmRss = multi
    ? values(warm, (run) =>
        (run.data?.clients ?? []).map((client: Run) => client.data?.rssBytes),
      )
    : warm.map((run: Run) => run.data?.rssBytes);
  const coldOperations = multi
    ? values(cold, (run) =>
        (run.data?.clients ?? []).map(
          (client: Run) => client.data?.operationMs,
        ),
      )
    : cold.map((run: Run) => run.data?.operationMs);
  const warmOperations = multi
    ? values(warm, (run) =>
        (run.data?.clients ?? []).flatMap((client: Run) =>
          (client.data?.warmSamples ?? []).map(
            (sample: Sample) => sample.operationMs,
          ),
        ),
      )
    : warm.flatMap((run: Run) =>
        (run.data?.warmSamples ?? []).map(
          (sample: Sample) => sample.operationMs,
        ),
      );
  const processCounts = (runs: Run[]) =>
    runs.map((run: Run) => run.data?.processCount);
  const childProcessCalls = (runs: Run[]) =>
    multi
      ? values(runs, (run) =>
          (run.data?.clients ?? []).map(
            (client: Run) => client.data?.childProcessLaunchCalls,
          ),
        )
      : runs.map((run: Run) => run.data?.childProcessLaunchCalls);
  const result: Record<string, unknown[]> = {
    coldWallMs: cold.map((run: Run) => run.elapsedMs),
    coldOperationMs: coldOperations,
    warmOperationMs: warmOperations,
    coldRssBytesPerProcess: coldRss,
    warmRssBytesPerProcess: warmRss,
    runtimeProcessesPerSample: processCounts(cold),
    warmRuntimeProcessesPerSample: processCounts(warm),
    coldChildProcessLaunchCalls: childProcessCalls(cold),
    warmChildProcessLaunchCalls: childProcessCalls(warm),
  };
  if (multi) {
    result["coldStatusOperationMs"] = values(cold, (run) =>
      (run.data?.clients ?? []).map(
        (client: Run) => client.data?.first?.statusMs,
      ),
    );
    result["warmStatusOperationMs"] = values(warm, (run) =>
      (run.data?.clients ?? []).flatMap((client: Run) =>
        (client.data?.warmSamples ?? []).map(
          (sample: Sample) => sample.fakeRpcOperationMs,
        ),
      ),
    );
    result["coldRssBytesAggregate"] = cold.map((run: Run) =>
      (run.data?.clients ?? []).reduce(
        (sum: number, client: Run) => sum + (client.data?.rssBytes ?? 0),
        0,
      ),
    );
    result["warmRssBytesAggregate"] = warm.map((run: Run) =>
      (run.data?.clients ?? []).reduce(
        (sum: number, client: Run) => sum + (client.data?.rssBytes ?? 0),
        0,
      ),
    );
    for (const [phase, runs] of [
      ["cold", cold],
      ["warm", warm],
    ] as const) {
      const rpc = runs.map((run: Run) => run.data?.fakeQueue ?? {});
      result[`${phase}FakeRpcCalls`] = rpc.map(
        (entry: import("./refactor-benchmark-data").FakeQueue) =>
          entry.wrapperCalls,
      );
      result[`${phase}FakeRpcRequestBytes`] = rpc.map(
        (entry: import("./refactor-benchmark-data").FakeQueue) =>
          entry.requestBytes,
      );
      result[`${phase}FakeRpcResponseBytes`] = rpc.map(
        (entry: import("./refactor-benchmark-data").FakeQueue) =>
          entry.responseBytes,
      );
      result[`${phase}ClientCount`] = runs.map(
        (run: Run) => run.data?.processCount,
      );
    }
  }
  if (name === "catalog") {
    result["catalogToolCount"] = cold.map(
      (run: Run) => run.data?.first?.catalogTools,
    );
    result["catalogPayloadBytes"] = cold.map(
      (run: Run) => run.data?.first?.catalogBytes,
    );
    result["catalogFrameBytes"] = cold.map(
      (run: Run) => run.data?.first?.catalogFrameBytes,
    );
  }
  if (name === "api-import") {
    result["apiExportCount"] = cold.map(
      (run: Run) => run.data?.first?.exportCount,
    );
    result["apiProcessLaunchCalls"] = cold.map(
      (run: Run) => run.data?.first?.processLaunchCalls,
    );
    result["apiActiveResourceDelta"] = cold.map(
      (run: Run) => run.data?.first?.newActiveResources,
    );
    result["apiActiveHandleDelta"] = cold.map(
      (run: Run) => run.data?.first?.newActiveHandles,
    );
  }
  if (name === "prepare-bundle") {
    result["bundleBytes"] = cold.map((run: Run) => run.data?.first?.bytes);
    result["bundleHashes"] = [
      ...new Set(cold.map((run: Run) => run.data?.first?.sha256)),
    ];
  }
  return result;
}

function compareFinal(baselineInput: unknown, candidateInput: unknown) {
  const baseline = data.report(baselineInput),
    candidate = data.report(candidateInput);
  const environmentKeys = [
    "node",
    "npm",
    "platform",
    "release",
    "arch",
    "cpu",
    "python",
    "wslDistro",
  ];
  const sameEnvironment = environmentKeys.every(
    (key) =>
      baseline.environment?.[key] !== undefined &&
      baseline.environment[key] === candidate.environment?.[key],
  );
  const sameFixture =
    typeof baseline.finalRuntime?.fixtureSha256 === "string" &&
    baseline.finalRuntime.fixtureSha256 ===
      candidate.finalRuntime?.fixtureSha256;
  const workloadNames = [
    "api-import",
    "help",
    "mcp",
    "catalog",
    "prepare-bundle",
    "multi-client",
  ];
  const measurements: Record<string, Record<string, unknown>> = {};
  for (const name of workloadNames) {
    const before = workloadMetrics(baseline, name);
    const after = workloadMetrics(candidate, name);
    measurements[name] = {
      coldWallMs: paired(before["coldWallMs"], after["coldWallMs"]),
      coldOperationMs: paired(
        before["coldOperationMs"],
        after["coldOperationMs"],
      ),
      warmOperationMs: paired(
        before["warmOperationMs"],
        after["warmOperationMs"],
      ),
      coldRssBytesPerProcess: paired(
        before["coldRssBytesPerProcess"],
        after["coldRssBytesPerProcess"],
      ),
      warmRssBytesPerProcess: paired(
        before["warmRssBytesPerProcess"],
        after["warmRssBytesPerProcess"],
      ),
      runtimeProcessesPerSample: paired(
        before["runtimeProcessesPerSample"],
        after["runtimeProcessesPerSample"],
      ),
      warmRuntimeProcessesPerSample: paired(
        before["warmRuntimeProcessesPerSample"],
        after["warmRuntimeProcessesPerSample"],
      ),
      childProcessLaunchCalls: {
        cold: paired(
          before["coldChildProcessLaunchCalls"],
          after["coldChildProcessLaunchCalls"],
        ),
        warm: paired(
          before["warmChildProcessLaunchCalls"],
          after["warmChildProcessLaunchCalls"],
        ),
      },
    };
    if (name === "multi-client") {
      measurements[name]["coldStatusOperationMs"] = paired(
        before["coldStatusOperationMs"],
        after["coldStatusOperationMs"],
      );
      measurements[name]["warmStatusOperationMs"] = paired(
        before["warmStatusOperationMs"],
        after["warmStatusOperationMs"],
      );
      measurements[name]["coldRssBytesAggregate"] = paired(
        before["coldRssBytesAggregate"],
        after["coldRssBytesAggregate"],
      );
      measurements[name]["warmRssBytesAggregate"] = paired(
        before["warmRssBytesAggregate"],
        after["warmRssBytesAggregate"],
      );
      measurements[name]["coldFakeRpcCalls"] = paired(
        before["coldFakeRpcCalls"],
        after["coldFakeRpcCalls"],
      );
      measurements[name]["warmFakeRpcCalls"] = paired(
        before["warmFakeRpcCalls"],
        after["warmFakeRpcCalls"],
      );
      measurements[name]["coldFakeRpcRequestBytes"] = paired(
        before["coldFakeRpcRequestBytes"],
        after["coldFakeRpcRequestBytes"],
      );
      measurements[name]["warmFakeRpcRequestBytes"] = paired(
        before["warmFakeRpcRequestBytes"],
        after["warmFakeRpcRequestBytes"],
      );
      measurements[name]["coldFakeRpcResponseBytes"] = paired(
        before["coldFakeRpcResponseBytes"],
        after["coldFakeRpcResponseBytes"],
      );
      measurements[name]["warmFakeRpcResponseBytes"] = paired(
        before["warmFakeRpcResponseBytes"],
        after["warmFakeRpcResponseBytes"],
      );
    }
    if (name === "catalog") {
      measurements[name]["toolCount"] = paired(
        before["catalogToolCount"],
        after["catalogToolCount"],
      );
      measurements[name]["metadataBytes"] = paired(
        before["catalogPayloadBytes"],
        after["catalogPayloadBytes"],
      );
      measurements[name]["frameBytes"] = paired(
        before["catalogFrameBytes"],
        after["catalogFrameBytes"],
      );
    }
    if (name === "api-import") {
      measurements[name]["apiProcessLaunchCalls"] = paired(
        before["apiProcessLaunchCalls"],
        after["apiProcessLaunchCalls"],
      );
      measurements[name]["apiExportCount"] = paired(
        before["apiExportCount"],
        after["apiExportCount"],
      );
      measurements[name]["activeResources"] = {
        baseline: before["apiActiveResourceDelta"],
        candidate: after["apiActiveResourceDelta"],
      };
      measurements[name]["activeHandles"] = {
        baseline: before["apiActiveHandleDelta"],
        candidate: after["apiActiveHandleDelta"],
      };
    }
    if (name === "prepare-bundle")
      measurements[name]["bundleBytes"] = paired(
        before["bundleBytes"],
        after["bundleBytes"],
      );
  }
  const beforePackage = baseline.measurements?.package?.data?.[0] ?? null;
  const afterPackage = candidate.measurements?.package?.data?.[0] ?? null;
  const complete =
    baseline.finalRuntime?.status === "pass" &&
    candidate.finalRuntime?.status === "pass" &&
    baseline.source === baselineSource &&
    isCompleteFinalRuntime(baseline.finalRuntime) &&
    isCompleteFinalRuntime(candidate.finalRuntime) &&
    Object.keys(baseline.suites ?? {}).length > 0 &&
    Object.keys(candidate.suites ?? {}).length > 0 &&
    Object.values(baseline.suites ?? {}).every(
      (suite: { status?: string | undefined }) => suite.status === "pass",
    ) &&
    Object.values(candidate.suites ?? {}).every(
      (suite: { status?: string | undefined }) => suite.status === "pass",
    ) &&
    baseline.measurements?.package?.status === "pass" &&
    candidate.measurements?.package?.status === "pass";
  return {
    version: 1,
    measuredAt: new Date().toISOString(),
    status: complete && sameEnvironment && sameFixture ? "pass" : "incomplete",
    source: {
      baseline: baseline.source,
      candidate: candidate.source,
    },
    environment: baseline.environment,
    sameEnvironment,
    sameFixture,
    fixtureSha256: baseline.finalRuntime?.fixtureSha256 ?? null,
    sampleCount: fixture.samples,
    warmIterations: fixture.warmIterations,
    clientCount: fixture.clients,
    performanceClaim:
      "Descriptive medians and spreads only; this report does not claim a statistically stable faster result.",
    scope:
      "Offline CLI/MCP/catalog/prepare-bundle and injected fake QueueClient only. No geometry, Fusion SDK, global broker, real IPC or user .cad data.",
    measurements,
    packageBytes: {
      baseline: beforePackage,
      candidate: afterPackage,
      sizeDelta:
        typeof beforePackage?.size === "number" &&
        typeof afterPackage?.size === "number"
          ? afterPackage.size - beforePackage.size
          : null,
      unpackedSizeDelta:
        typeof beforePackage?.unpackedSize === "number" &&
        typeof afterPackage?.unpackedSize === "number"
          ? afterPackage.unpackedSize - beforePackage.unpackedSize
          : null,
      wallMs: paired(
        [baseline.measurements?.package?.elapsedMs].filter(
          (value: unknown): value is number => typeof value === "number",
        ),
        [candidate.measurements?.package?.elapsedMs].filter(
          (value: unknown): value is number => typeof value === "number",
        ),
      ),
      processCount: {
        baseline: baseline.measurements?.package?.processCount ?? null,
        candidate: candidate.measurements?.package?.processCount ?? null,
      },
    },
    suites: {
      baseline: Object.fromEntries(
        Object.entries(baseline.suites ?? {}).map(([name, suite]) => [
          name,
          suite.status,
        ]),
      ),
      candidate: Object.fromEntries(
        Object.entries(candidate.suites ?? {}).map(([name, suite]) => [
          name,
          suite.status,
        ]),
      ),
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const [mode, rootArg = ".", output] = args;
  if (mode === "compare-final") {
    const comparisonOutput = args[3];
    if (!output || !comparisonOutput)
      throw new Error("compare-final BASELINE CANDIDATE OUTPUT");
    const result = compareFinal(
      data.json(readFileSync(rootArg, "utf8")),
      data.json(readFileSync(output, "utf8")),
    );
    mkdirSync(dirname(resolve(comparisonOutput)), { recursive: true });
    writeFileSync(comparisonOutput, JSON.stringify(result, null, 2) + "\n");
    console.log(
      JSON.stringify({ output: comparisonOutput, status: result.status }),
    );
    if (result.status !== "pass") process.exitCode = 1;
    return;
  }
  const root = resolve(rootArg);
  const require = createRequire(join(root, "package.json"));
  if (mode === "--final-worker") {
    const [, , kind, phase, projectDirectory, clientId, warmArg] = args;
    if (
      typeof kind !== "string" ||
      ![
        "api-import",
        "help",
        "mcp",
        "catalog",
        "prepare-bundle",
        "multi-client",
      ].includes(kind) ||
      typeof phase !== "string" ||
      !["cold", "warm"].includes(phase) ||
      !projectDirectory ||
      !clientId
    )
      throw new Error(
        "--final-worker ROOT KIND PHASE PROJECT CLIENT WARM_COUNT",
      );
    const result = await runFinalWorker(
      root,
      kind as FinalWorkload,
      phase as "cold" | "warm",
      projectDirectory,
      clientId,
      Number(warmArg),
    );
    console.log(JSON.stringify(result));
  } else if (mode === "--multi-worker") {
    const [, , directory, projectDirectory, phase] = args;
    if (
      !directory ||
      !projectDirectory ||
      typeof phase !== "string" ||
      !["cold", "warm"].includes(phase)
    )
      throw new Error("--multi-worker ROOT DIRECTORY PROJECT PHASE");
    const result = await runMultiClientSample(
      root,
      directory,
      projectDirectory,
      phase as "cold" | "warm",
    );
    console.log(JSON.stringify(result));
    if (result.status !== "pass") process.exitCode = 1;
  } else if (mode === "--worker") {
    const name = output;
    const samples = [];
    for (let i = 0; i < 6; i++) {
      const started = performance.now();
      if (name === "import") require("./src/cli");
      else if (name === "help") {
        const code = await moduleFunction(
          root,
          "./src/cli",
          "main",
        )(["--help"], {
          stdout: { write() {} },
          stderr: { write() {} },
          setExitCode() {},
          loadConfig() {
            throw new Error("help touched configuration");
          },
        });
        if (code !== 0) throw new Error(`help exited ${code}`);
      } else if (name === "prepare-bundle") {
        moduleFunction(root, "./src/cad", "buildCadScript")(
          "status",
          {},
          { doc: "Synthetic", docId: "fixture" },
        );
      } else if (name === "mcp-startup") {
        const stdin = new PassThrough();
        const server = data.record(
          moduleFunction(
            root,
            "./src/mcp-stdio",
            "startStdio",
          )([], {
            stdin,
            stdout: { write() {} },
            stderr: {
              write(s: string) {
                throw new Error(s);
              },
            },
          }),
        );
        stdin.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
        await server["closed"];
      } else throw new Error(`unknown worker ${name}`);
      samples.push({
        elapsedMs: performance.now() - started,
        rssBytes: process.memoryUsage().rss,
      });
    }
    console.log(
      JSON.stringify({
        cold: samples[0],
        warm: samples.slice(1),
        maxRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  } else if (mode === "measure") {
    if (!output) throw new Error("measure ROOT OUTPUT");
    const directory = mkdtempSync(
      join(tmpdir(), "fmcad-refactor-baseline-measure-"),
    );
    const environmentRoot = join(directory, "environment");
    mkdirSync(environmentRoot);
    const env = isolatedEnvironment(environmentRoot);
    try {
      const report: Report = {
        version: 1,
        measuredAt: new Date().toISOString(),
        source: command("git", ["rev-parse", "HEAD"], root).stdout.trim(),
        environment: {
          node: process.version,
          npm: command(
            "npm",
            ["--version"],
            directory,
            30000,
            undefined,
            env,
          ).stdout.trim(),
          platform: platform(),
          release: release(),
          arch: process.arch,
          cpu: cpus()[0]?.model,
          python: command(
            "python3",
            ["--version"],
            directory,
            30000,
            undefined,
            env,
          ).stdout.trim(),
          wslDistro: process.env["WSL_DISTRO_NAME"] ?? null,
        },
        definitions: {
          cold: "first operation in fresh child, including imports",
          warm: "five repeats in same child; import is module-cache lookup",
          startup:
            "local offline MCP tools/list frame through EOF and close; NOT Fusion",
          package:
            "npm pack --dry-run --ignore-scripts --json: compressed estimate and unpacked bytes, no tarball written; package allowlist determines included content and no documentation files are moved",
          rss: "per-sample process RSS bytes and process high-water maxRSS KiB; command elapsedMs includes process launch",
          safety:
            "synthetic/fake only; HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME, XDG_STATE_HOME and temp are isolated below unique os.tmpdir directories; WSL_DISTRO_NAME is preserved only for platform mapping; no real config, queue, Fusion or SDK; timeout is not pass",
        },
        measurements: {},
        suites: {},
      };
      for (const name of ["import", "help", "mcp-startup", "prepare-bundle"]) {
        const runs = [];
        for (let i = 0; i < 3; i++) {
          const result = command(
            process.execPath,
            ["--experimental-strip-types", __filename, "--worker", root, name],
            directory,
            30000,
            undefined,
            env,
          );
          runs.push({
            ...result,
            stdout: undefined,
            data:
              result.status === "pass"
                ? data.workerData(data.json(result.stdout))
                : null,
          });
        }
        report.measurements[name] = runs;
      }
      const idle = command(
        process.execPath,
        ["scripts/benchmark-queue-idle.js"],
        root,
        30000,
        undefined,
        env,
      );
      report.measurements["queueIdle"] = {
        ...idle,
        stdout: undefined,
        data: idle.status === "pass" ? data.json(idle.stdout) : null,
      };
      const pack = command(
        "npm",
        [
          "pack",
          "--dry-run",
          "--ignore-scripts",
          "--json",
          "--cache",
          join(directory, "npm-cache"),
        ],
        root,
        120000,
        undefined,
        { ...env, npm_config_cache: join(directory, "npm-cache") },
      );
      report.measurements.package = {
        ...pack,
        stdout: undefined,
        data:
          pack.status === "pass"
            ? data.packageData(data.json(pack.stdout))
            : null,
      };
      const suites = [
        "help-details",
        "mcp-stdio",
        "cad",
        "run-file",
        "batch-local",
        "document-identity",
        "outcome",
        "queue-native-receipt",
        "recovery-isolation",
      ];
      for (const suite of suites) {
        const selection =
          suite === "cad"
            ? "every catalog example validates|unsupported input flags|advertised component input"
            : null;
        const args = [
          "--test",
          ...(selection ? ["--test-name-pattern", selection] : []),
          !existsSync(join(root, `tests/${suite}.test.js`)) &&
          existsSync(join(root, `tests/${suite}.test.ts`))
            ? `dist/tests/${suite}.test.js`
            : `tests/${suite}.test.js`,
        ];
        const result = command(
          process.execPath,
          args,
          root,
          120000,
          undefined,
          env,
        );
        report.suites[suite] = {
          ...result,
          command: [process.execPath, ...args],
          selection,
          unselected: selection
            ? {
                status: "skip",
                reason:
                  "The full CAD suite is intentionally excluded to keep this offline benchmark bounded; selected cases validate catalog examples and input-safety contracts only.",
              }
            : null,
        };
      }
      report.finalRuntime = await measureFinalRuntime(root, directory);
      report.finalRuntime.status = isCompleteFinalRuntime(report.finalRuntime)
        ? "pass"
        : "incomplete";
      mkdirSync(dirname(resolve(output)), { recursive: true });
      writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
      const failed = Object.entries(report.suites)
        .filter(([, x]) => x.status !== "pass")
        .map(([name]) => name);
      console.log(
        JSON.stringify({
          output,
          failedSuites: failed,
          measurements: Object.keys(report.measurements),
          finalRuntime: report.finalRuntime.status,
        }),
      );
      process.exitCode =
        failed.length ||
        Object.values(report.measurements).some((x: unknown) =>
          Array.isArray(x)
            ? x.some((r: unknown) => data.record(r)["status"] !== "pass")
            : data.record(x)["status"] !== "pass",
        ) ||
        report.finalRuntime.status !== "pass"
          ? 1
          : 0;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  } else
    throw new Error("Expected measure ROOT OUTPUT or benchmark worker mode");
}
if (require.main === module)
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });

export type FinalBenchmarkHarness = {
  compareFinal: typeof compareFinal;
  isCompleteFinalRuntime: typeof isCompleteFinalRuntime;
  isWithin: typeof isWithin;
  summarizeSamples: typeof summarizeSamples;
};
module.exports = {
  compareFinal,
  isCompleteFinalRuntime,
  isWithin,
  summarizeSamples,
} satisfies FinalBenchmarkHarness;
