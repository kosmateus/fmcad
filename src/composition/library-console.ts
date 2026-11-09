import path from "node:path";
import { createRequire } from "node:module";
import { loadConfig as defaultLoadConfig } from "./library-configuration";
import type { CommandDescriptor } from "./library-commands";
const hostRequire = createRequire(__filename);
export interface ConsoleInput {
  isTTY?: boolean | undefined;
}
export interface ConsoleOutput {
  isTTY?: boolean | undefined;
  write(text: string): unknown;
}
export interface ConsoleConfiguration {
  cfg: { controlCenter: { port: number } };
}
export interface ControlCenterLaunch {
  url: string;
  projectId: string | null;
  dispose(): void | Promise<void>;
}
export type OpenControlCenter = (options: {
  port: number;
  projectPath?: string;
}) => Promise<ControlCenterLaunch>;
export interface ConsoleDependencies {
  cwd?: string;
  stdin?: ConsoleInput;
  stdout: ConsoleOutput;
  signals?: unknown;
  loadConfig?: (options: { config?: string }) => ConsoleConfiguration;
  openControlCenter?: OpenControlCenter;
}
export interface ConsoleOptions {
  project?: string;
  config?: string;
  web?: true;
}
export const descriptor: CommandDescriptor = {
  usage: "console [--web] [--project PATH] [--config PATH]",
  desc: "Print the ready Control Center URL. Works without an interactive terminal. diagnostic and --web are compatibility aliases.",
  example: 'fmcad console --project "/path/to/project"',
  extra:
    "Without --project, opens the global view. An explicit project must resolve to exactly one registered project; artifact directories are not a registration fallback. Uses the configured Control Center port and prints its URL after readiness. Closing this command releases only caller resources and does not resume or stop a broker. Broker inspect, stop, restart and reload remain explicit administrative CLI commands.",
};
export function parse(argv: readonly string[]): ConsoleOptions {
  const options: ConsoleOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === "--web") {
      if (options.web !== undefined)
        throw new Error(`Invalid or duplicate console option: ${key}`);
      options.web = true;
      continue;
    }
    if (
      !["--project", "--config"].includes(key) ||
      options[key.slice(2) as "project" | "config"] !== undefined
    )
      throw new Error(`Invalid or duplicate console option: ${key}`);
    const value = argv[++i];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${key}`);
    options[key.slice(2) as "project" | "config"] = value;
  }
  return options;
}
export async function consoleCommand(
  argv: readonly string[],
  deps: ConsoleDependencies,
): Promise<number> {
  const options = parse(argv),
    cwd = deps.cwd || process.cwd();
  const { cfg } = (deps.loadConfig ?? defaultLoadConfig)(
    options.config ? { config: options.config } : {},
  );
  const open = deps.openControlCenter ?? openWebConsole;
  const launched = await open({
    port: cfg.controlCenter.port,
    ...(options.project === undefined
      ? {}
      : { projectPath: path.resolve(cwd, options.project) }),
  });
  try {
    deps.stdout.write(launched.url + "\n");
    return 0;
  } finally {
    await launched.dispose();
  }
}
export async function openWebConsole(
  options: Parameters<OpenControlCenter>[0],
): Promise<ControlCenterLaunch> {
  const service = hostRequire("./control-center") as {
    openControlCenter?: OpenControlCenter;
  };
  if (typeof service.openControlCenter !== "function")
    throw Object.assign(
      new Error(
        "This installation does not expose the Control Center public launch contract",
      ),
      { code: "CONTROL_CENTER_PUBLIC_ENTRY_UNAVAILABLE" },
    );
  return service.openControlCenter(options);
}
