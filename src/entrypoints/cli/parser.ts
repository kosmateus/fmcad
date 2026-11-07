import { CliError } from "./messages";
import type { ExecuteOptions } from "../../api";

export interface CommandEntry {
  key: string;
  kind: string;
  usage: string;
  target?: string;
  aliases?: string[];
  flags: Record<string, "value" | "boolean">;
  listFlags?: string[];
  minArgs: number;
  maxArgs: number;
  requiresDoc?: boolean;
  exactlyOne?: string[];
}
export interface CliOptions {
  headers: Record<string, string>;
  description?: string;
  timeoutMs?: number;
  [key: string]: string | number | Record<string, string> | undefined;
}
export type CommandFlags = Record<string, string | boolean>;
/** Validate all broker controls before configuration, registration or admission. */
export function executionOptions(
  opts: CliOptions,
): Omit<ExecuteOptions, "requestId"> {
  const number = (
    name: string,
    maximum: number,
    minimum: number,
  ): number | undefined => {
    const raw = opts[name];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new CliError("invalidOption", { flag: "--" + name });
    return value;
  };
  const queueTimeoutMs = number("queue-timeout", 2147483647, 1);
  const expectedRevision = number(
    "expected-revision",
    Number.MAX_SAFE_INTEGER,
    0,
  );
  let sequence: ExecuteOptions["sequence"];
  if (
    opts["sequence-action"] !== undefined ||
    opts["sequence-id"] !== undefined ||
    opts["sequence-mode"] !== undefined
  ) {
    const action = opts["sequence-action"],
      id = opts["sequence-id"],
      mode = opts["sequence-mode"];
    if (
      (action !== "begin" && action !== "continue" && action !== "end") ||
      (action === "begin"
        ? id !== undefined
        : typeof id !== "string" || !id.trim() || id.length > 256) ||
      (mode !== undefined && mode !== "automatic" && mode !== "exclusive")
    )
      throw new CliError("sequence");
    sequence = {
      action,
      ...(typeof id === "string" ? { id } : {}),
      ...(mode ? { mode } : {}),
    };
  }
  if (
    opts["request-id"] !== undefined &&
    (typeof opts["request-id"] !== "string" ||
      !opts["request-id"].trim() ||
      opts["request-id"].length > 256)
  )
    throw new CliError("invalidOption", { flag: "--request-id" });
  return {
    ...(sequence ? { sequence } : {}),
    ...(queueTimeoutMs === undefined ? {} : { queueTimeoutMs }),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}
interface ParserPorts {
  globalFlags: Record<string, unknown>;
  parseInvocation(argv: string[]): { argv: string[]; description?: string };
  validateRunOutput(flags: CommandFlags, listing?: boolean): void;
  validateRunIdentity(flags: CommandFlags, listing?: boolean): void;
}
function defaults(): ParserPorts {
  // The staged adapter sits in src/dist/entrypoints/cli. These are retained
  // declaration/pure-validation facades, never another parser or transport.
  return {
    globalFlags: require("../../../commands").globalFlags,
    parseInvocation: require("../../../invocation").parseInvocation,
    ...require("../../../run"),
  } as ParserPorts;
}
export function flagValue(argv: readonly string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value === "" || /^--|^-[A-Za-z]/.test(value))
    throw new CliError("missingValue", { flag: argv[index] ?? "" });
  return value;
}
export function parseFlags(
  input: string[],
  ports = defaults(),
): { opts: CliOptions; rest: string[] } {
  const invocation = ports.parseInvocation(input);
  const argv = invocation.argv;
  const opts: CliOptions = { headers: {} };
  if (invocation.description) opts.description = invocation.description;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (!Object.hasOwn(ports.globalFlags, flag)) {
      rest.push(flag);
      continue;
    }
    const value = flagValue(argv, i++);
    if (flag === "--header") {
      const colon = value.indexOf(":");
      if (colon < 1) throw new CliError("header");
      opts.headers[value.slice(0, colon)] = value.slice(colon + 1);
    } else if (flag === "--timeout") {
      opts.timeoutMs = Number(value);
      if (!Number.isFinite(opts.timeoutMs)) throw new CliError("timeout");
    } else opts[flag.slice(2)] = value;
  }
  return { opts, rest };
}
export function parseCommand(
  entry: CommandEntry,
  rawArgs: string[],
  ports = defaults(),
) {
  const args: string[] = [];
  const flags: CommandFlags = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i]!;
    if (token === "--") {
      args.push(...rawArgs.slice(i + 1));
      break;
    }
    if (Object.hasOwn(entry.flags, token)) {
      if (
        entry.kind === "run" &&
        ["--doc-id", "--doc-file-id"].includes(token)
      ) {
        if (Object.hasOwn(flags, token))
          throw new CliError("duplicateRun", { flag: token });
        const value = flagValue(rawArgs, i);
        if (!value || /\s/.test(value) || value.startsWith("-"))
          throw new CliError("identity", { flag: token });
      }
      flags[token] =
        entry.flags[token] === "value" ? flagValue(rawArgs, i++) : true;
    } else if (/^--|^-[A-Za-z]/.test(token)) {
      throw new CliError("unknownOption", { command: entry.key, flag: token });
    } else args.push(token);
  }
  const listing = !!entry.listFlags?.some((flag) => flags[flag]);
  if (entry.kind === "run") {
    ports.validateRunOutput(flags, listing);
    ports.validateRunIdentity(flags, listing);
    if (flags["--args"] !== undefined && flags["--args-file"] !== undefined)
      throw new CliError("runArgs");
  }
  if (
    args.length < (listing ? 0 : entry.minArgs) ||
    args.length > entry.maxArgs
  )
    throw new CliError("usage", { usage: entry.usage });
  if (entry.requiresDoc && !flags["--doc"])
    throw new CliError("document", { command: entry.key });
  if (
    entry.exactlyOne &&
    entry.exactlyOne.filter((flag) => flags[flag]).length !== 1
  )
    throw new CliError("exactlyOne", {
      command: entry.key,
      flags: entry.exactlyOne.join(" or "),
    });
  if (entry.key === "plane_add") {
    const count = ({ offset: 4, mid: 4, angle: 5 } as Record<string, number>)[
      args[1] ?? ""
    ];
    if (!count || args.length !== count)
      throw new CliError("usage", { usage: entry.usage });
  }
  if (entry.key === "projects" && args.length)
    throw new CliError("usage", { usage: "projects" });
  return { args, flags, listing };
}
