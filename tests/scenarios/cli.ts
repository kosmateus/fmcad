import * as fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  CheckedSimulatorBackend,
  PythonSimulator,
  simulatorCapabilities,
  simulatorEndpoint,
  simulatorFolder,
} from "./simulator";
import { QueueScenarioBackend } from "./queue-backend";
import { foundationScenarios, savedScenarios } from "./cases";
import { parameterScenarios } from "./parameter-cases";
import { runScenarios, resumeCleanup } from "./runner";
import { concurrencyLimit, defaultConcurrency, sourceHash } from "./scheduling";
import type { FixtureFolder, Protocol, ScenarioBackend } from "./contracts";
import type { createBrokerTransport } from "../../packages/node-adapters/src/fusion-transport/broker";
import type {
  detectPlatform,
  toWindowsPath,
} from "../../packages/node-adapters/src/config-platform/platform";

interface Options {
  backend: "fusion" | "simulator";
  profile: "broker" | "component";
  protocol: Protocol;
  concurrency: number;
  owners: number;
  run: boolean;
  suite: "foundation" | "saved" | "parameters" | "all";
  folder?: FixtureFolder;
  cleanup?: string;
}
export function parse(argv: string[]): Options {
  let backend: Options["backend"] = "simulator",
    profile: Options["profile"] = "broker",
    protocol: Protocol = "mcp";
  let concurrency: number | undefined,
    owners = 10,
    run = false;
  let cleanup: string | undefined;
  let suite: Options["suite"] = "all";
  let projectId: string | undefined, folderId: string | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!flag || seen.has(flag))
      throw new Error("Invalid/duplicate scenario option: " + flag);
    seen.add(flag);
    if (flag === "--run") {
      run = true;
      continue;
    }
    const value = argv[++index];
    if (flag === "--backend" && (value === "fusion" || value === "simulator"))
      backend = value;
    else if (
      flag === "--profile" &&
      (value === "broker" || value === "component")
    )
      profile = value;
    else if (flag === "--protocol" && (value === "mcp" || value === "addin"))
      protocol = value;
    else if (
      flag === "--suite" &&
      (value === "foundation" ||
        value === "saved" ||
        value === "parameters" ||
        value === "all")
    )
      suite = value;
    else if (flag === "--project-id" && value && !value.startsWith("--"))
      projectId = value;
    else if (flag === "--folder-id" && value && !value.startsWith("--"))
      folderId = value;
    else if (flag === "--cleanup" && value && !value.startsWith("--"))
      cleanup = path.resolve(value);
    else if (
      (flag === "--concurrency" || flag === "--owners") &&
      value &&
      /^[1-9][0-9]*$/.test(value)
    ) {
      const number = concurrencyLimit(Number(value));
      if (flag === "--concurrency") concurrency = number;
      else owners = number;
    } else
      throw new Error("Invalid scenario option/value: " + flag + " " + value);
  }
  if (backend === "fusion" && (!run || profile !== "broker"))
    throw new Error(
      "Live Fusion requires --run and the broker profile; no direct fallback",
    );
  if (cleanup && backend !== "fusion")
    throw new Error(
      "Process-restart cleanup requires the original live Fusion backend; a new simulator is a different instance",
    );
  if (Boolean(projectId) !== Boolean(folderId))
    throw new Error("Provide both --project-id and --folder-id");
  if (
    backend === "fusion" &&
    suite !== "foundation" &&
    !cleanup &&
    (!projectId || !folderId)
  )
    throw new Error(
      "Saved Fusion scenarios require an explicitly configured --project-id and --folder-id",
    );
  return {
    backend,
    profile,
    protocol,
    owners,
    run,
    suite,
    ...(projectId && folderId
      ? { folder: { projectId, folderId } }
      : backend === "simulator"
        ? { folder: simulatorFolder }
        : {}),
    concurrency: concurrency ?? defaultConcurrency(backend),
    ...(cleanup ? { cleanup } : {}),
  };
}
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parse(argv);
  const root = path.resolve(__dirname, "../../..");
  const output = path.join(root, ".test-artifacts/scenarios");
  const temporary = path.join(output, "checker");
  fs.mkdirSync(temporary, { recursive: true });
  const load = createRequire(path.join(root, "package.json"));
  let model: PythonSimulator | undefined;
  let endpoint: Awaited<ReturnType<typeof simulatorEndpoint>> | undefined;
  let broker: { close(): Promise<void> } | undefined;
  let backend: ScenarioBackend;
  let queue: QueueScenarioBackend | undefined;
  const originalEnvironment = new Map<string, string | undefined>();
  const hashSources = (): string =>
    sourceHash({
      tests: path.join(root, "tests"),
      runtime: path.join(root, "runtime/python/fmcad"),
      assets: path.join(root, "assets"),
    });
  const sourceBefore = hashSources();
  try {
    if (options.backend === "fusion") {
      const { cfg } = (
        load("./src/config") as {
          loadConfig(options: { routing: "queue" }): {
            cfg: Record<string, unknown>;
          };
        }
      ).loadConfig({ routing: "queue" });
      if (cfg["backend"] !== options.protocol)
        throw new Error(
          "Configured broker backend differs from --protocol; no broker was started or changed",
        );
      const platform = load("./src/dist/config-platform") as {
        toWindowsPath: typeof toWindowsPath;
        detectPlatform: typeof detectPlatform;
      };
      queue = new QueueScenarioBackend(
        "fusion",
        options.protocol,
        simulatorCapabilities,
        root,
        cfg,
        (file) => platform.toWindowsPath(file, platform.detectPlatform()),
      );
      backend = queue;
    } else if (options.profile === "component") {
      model = new PythonSimulator(root);
      backend = new CheckedSimulatorBackend(
        model,
        options.protocol,
        root,
        temporary,
      );
    } else {
      // Real process identity is a prerequisite, not a test condition to stub away.
      const identity = load("./src/queue-instance") as {
        processBirth(): string;
      };
      identity.processBirth();
      const state = path.join(
        path.dirname(root),
        ".scenario-state",
        randomUUID().slice(0, 8),
      );
      for (const [key, value] of Object.entries({
        XDG_STATE_HOME: state,
        XDG_CONFIG_HOME: state + "-config",
        XDG_CACHE_HOME: state + "-cache",
      })) {
        originalEnvironment.set(key, process.env[key]);
        process.env[key] = value;
        fs.mkdirSync(value, { recursive: true });
      }
      model = new PythonSimulator(root);
      endpoint = await simulatorEndpoint(model);
      const cfg = {
        backend: options.protocol,
        routing: "queue",
        transport: "http",
        tool: "fusion_mcp_execute",
        url: endpoint.url,
        timeoutMs: 180000,
        queue: { autoStart: false },
      };
      const transport = load("./src/dist/fusion-transport/broker") as {
        createBrokerTransport: typeof createBrokerTransport;
      };
      const module = load("./src/queue-broker") as {
        serve(
          config: typeof cfg,
          options: {
            confirmOwnership: true;
            createBackend(): ReturnType<typeof createBrokerTransport>;
            nativePath(file: string): string;
          },
        ): Promise<{ close(): Promise<void> }>;
      };
      broker = await module.serve(cfg, {
        confirmOwnership: true,
        nativePath: (file) => file,
        createBackend: () =>
          transport.createBrokerTransport(cfg, {
            version: "test",
            requestTimeout: () => 180000,
            bridgeSource: () =>
              fs.readFileSync(
                path.join(root, "assets/cad/identity.py"),
                "utf8",
              ) +
              "\n" +
              fs.readFileSync(
                path.join(root, "assets/addin-bridge.py"),
                "utf8",
              ),
          }),
      });
      queue = new QueueScenarioBackend(
        "simulator",
        options.protocol,
        simulatorCapabilities,
        root,
        cfg,
        (file) => file,
      );
      backend = queue;
    }
    if (options.cleanup) {
      const report = await resumeCleanup(backend, options.cleanup);
      console.log(
        JSON.stringify(
          {
            cleanup: report.cleanup,
            scenarioStatus: report.status,
            report: options.cleanup,
          },
          null,
          2,
        ),
      );
      return report.cleanup === "complete" ? 0 : 1;
    }
    const cancellation = new AbortController();
    const cancel = (): void =>
      cancellation.abort(
        new Error("Scenario run interrupted; waiting for settled cleanup"),
      );
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    let reports;
    try {
      reports = await runScenarios(
        backend,
        [
          ...(options.suite === "foundation" || options.suite === "all"
            ? foundationScenarios(options.owners)
            : []),
          ...((options.suite === "saved" || options.suite === "all") &&
          options.folder
            ? savedScenarios(options.folder, options.owners)
            : []),
          ...((options.suite === "parameters" || options.suite === "all") &&
          options.folder
            ? parameterScenarios(options.folder)
            : []),
        ],
        output,
        options.concurrency,
        cancellation.signal,
      );
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    const sourceAfter = hashSources();
    const passed =
      sourceBefore === sourceAfter &&
      reports.every((report) => report.status === "passed");
    console.log(
      JSON.stringify(
        {
          ...options,
          qualification: backend.qualification,
          sourceBefore,
          sourceAfter,
          status: passed ? "passed" : "failed",
          reports: reports.map((report) => ({
            id: report.owner.scenarioId,
            status: report.status,
            cleanup: report.cleanup,
            report: path.join(report.directory, "report.json"),
          })),
        },
        null,
        2,
      ),
    );
    return passed ? 0 : 1;
  } finally {
    queue?.close();
    try {
      await broker?.close();
    } finally {
      try {
        await endpoint?.close();
      } finally {
        await model?.close();
      }
      for (const [key, value] of originalEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
}
if (require.main === module)
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
