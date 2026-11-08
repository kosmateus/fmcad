import path from "node:path";
import { createRequire } from "node:module";
import { resolveProject } from "./library-console-project";
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
export interface ConsoleLaunchOptions {
  project: string | null;
  config: string | undefined;
  stdin: ConsoleInput;
  stdout: ConsoleOutput;
  loadConfig:
    ((options: { config?: string }) => ConsoleConfiguration) | undefined;
  signals: unknown;
  cwd: string;
}
export interface ConsoleDependencies {
  cwd?: string;
  stdin?: ConsoleInput;
  stdout: ConsoleOutput;
  signals?: unknown;
  loadConfig?: (options: { config?: string }) => ConsoleConfiguration;
  launchConsole?: (options: ConsoleLaunchOptions) => number | Promise<number>;
  openControlCenter?: OpenControlCenter;
}
export interface ConsoleOptions {
  project?: string;
  config?: string;
  web?: true;
}
export const descriptor: CommandDescriptor = {
  usage: "console [--web] [--project PATH] [--config PATH]",
  desc: "Open the terminal console, or print a ready Control Center URL with --web. The terminal reads broker state and retained historical observations without starting a broker or contacting Fusion. It requires an interactive terminal. diagnostic is a compatibility alias.",
  example: 'fmcad console --project "/path/to/project"',
  extra:
    "Without --project, the terminal discovers the nearest ancestor containing fmcad workflow artifacts. Outside a project, enter a path interactively or continue without context. q, Ctrl+C and SIGTERM restore the terminal; closing it does not resume or stop a broker. Settings select EN/PL for the console and independent command help. --purpose TEXT attaches optional invocation intent.\n\n--web uses the configured Control Center port and prints its URL after service readiness; it works without a TTY. Without --project it opens the global view. An explicit project must resolve to exactly one registered project; unregistered artifact directories are not a web fallback. The shared service owns its lifetime; this caller releases only its own resources. Terminal-only administrative operations remain available in the default console pending Control Center parity.",
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
  if (options.web) {
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
  const project = resolveProject({ ...options, cwd });
  const stdin = deps.stdin || process.stdin;
  if (!stdin.isTTY || !deps.stdout.isTTY || process.env["TERM"] === "dumb")
    throw new Error(
      (hostRequire("../../i18n") as { t(key: string): string }).t("terminal"),
    );
  return (deps.launchConsole ?? launchConsole)({
    project,
    config: options.config,
    stdin,
    stdout: deps.stdout,
    loadConfig: deps.loadConfig,
    signals: deps.signals || process,
    cwd,
  });
}
export function launchConsole(
  options: ConsoleLaunchOptions,
): number | Promise<number> {
  return (
    hostRequire("../../console-app") as {
      launchConsole(options: ConsoleLaunchOptions): number | Promise<number>;
    }
  ).launchConsole(options);
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
