import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { resolveRuntimePaths } from "./runtime-paths.js";
export * from "./runtime-paths.js";
export * from "./platform.js";
export * from "./python.js";
import type {
  AcceptedServiceConfiguration,
  ConfigLayer,
  ConfigSources,
} from "@fmcad/core";

type RecordValue = Record<string, unknown>;

export interface NodeConfigSources extends ConfigSources {
  readonly path: string;
}

export interface ConfigInitPlan {
  readonly path: string;
  readonly config: RecordValue;
  readonly note: string;
  readonly scriptsDir: string;
  readonly imported: boolean;
  readonly force: boolean;
}

const OPENCODE_CONFIGS = [
  [".opencode", "opencode.jsonc"],
  [".opencode", "opencode.json"],
  [".config", "opencode", "opencode.jsonc"],
  [".config", "opencode", "opencode.json"],
] as const;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown, name: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  return value;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} must be a nonempty string`);
  return value;
}

function parsedNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.trim() === "") return value;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function jsoncError(text: string, error: ParseError): string {
  const offset = Math.max(0, Math.min(error.offset, text.length));
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const line = text.slice(0, offset).split("\n").length;
  return `Invalid JSONC (line ${line} column ${offset - lineStart + 1})`;
}

export function parseJsonc(text: string): RecordValue {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  if (errors.length > 0) throw new Error(jsoncError(text, errors[0]!));
  if (!isRecord(value)) throw new Error("Configuration must be a JSON object");
  return value;
}

function parseConfigFile(
  file: string,
  kind: "config" | "OpenCode",
): RecordValue | null {
  if (!existsSync(file)) return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`Cannot read ${kind} configuration ${file}`);
  }
  try {
    return parseJsonc(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSONC";
    throw new Error(
      kind === "config"
        ? `Cannot parse config ${file}: ${message}`
        : `Cannot parse ${file}: ${message}`,
    );
  }
}

export function defaultConfigPath(): string {
  return resolveRuntimePaths({
    anchor: __filename,
    env: { ...process.env, FMCAD_CONFIG: "" },
  }).config;
}

function acceptedServicePath(): string {
  return join(
    resolveRuntimePaths({ anchor: __filename }).state,
    "control-center",
    "accepted-service.json",
  );
}

function selectedConfigPath(options: RecordValue): string {
  const fromOptions = options["config"];
  return resolveRuntimePaths({
    anchor: __filename,
    ...(fromOptions !== undefined
      ? { config: asString(fromOptions, "config path") }
      : {}),
  }).config;
}

function numericAliases(source: NodeJS.ProcessEnv): RecordValue {
  const values: RecordValue = {};
  for (const [environmentName, key] of [
    ["FMCAD_TIMEOUT_MS", "timeoutMs"],
    ["FMCAD_TIMEOUT", "timeout"],
    ["FMCAD_CONTROL_CENTER_PORT", "controlCenterPort"],
  ] as const) {
    const value = source[environmentName];
    if (value !== undefined) values[key] = parsedNumber(value);
  }
  return values;
}

function readEnvironment(): RecordValue {
  const source = process.env;
  const environment: RecordValue = numericAliases(source);
  const direct = [
    ["FMCAD_BACKEND", "backend"],
    ["FMCAD_URL", "url"],
    ["FMCAD_ENDPOINT", "endpoint"],
    ["FMCAD_TOOL", "tool"],
    ["FMCAD_TRANSPORT", "transport"],
    ["FMCAD_CURL_PATH", "curlPath"],
    ["FMCAD_PROTOCOL_VERSION", "protocolVersion"],
    ["FMCAD_ROUTING", "routing"],
  ] as const;
  for (const [environmentName, key] of direct) {
    const value = source[environmentName];
    if (value !== undefined) environment[key] = value;
  }

  if (source["FMCAD_HEADERS"] !== undefined) {
    try {
      const headers: unknown = JSON.parse(source["FMCAD_HEADERS"]!);
      environment["headers"] = headers;
    } catch {
      throw new Error(
        "FMCAD_HEADERS must contain a JSON object of header strings",
      );
    }
  }

  const queue: RecordValue = {};
  for (const [environmentName, key] of [
    ["FMCAD_QUEUE_STARTUP_TIMEOUT_MS", "startupTimeoutMs"],
    ["FMCAD_QUEUE_WAIT_TIMEOUT_MS", "waitTimeoutMs"],
    ["FMCAD_QUEUE_PREPARATION_CONCURRENCY", "preparationConcurrency"],
  ] as const) {
    const value = source[environmentName];
    if (value !== undefined) queue[key] = parsedNumber(value);
  }

  for (const [environmentName, key] of [
    ["FMCAD_QUEUE_AUTO_START", "autoStart"],
    ["FMCAD_QUEUE_AUTO_RECOVER", "autoRecover"],
  ] as const) {
    const value = source[environmentName];
    if (value !== undefined)
      queue[key] = value === "true" ? true : value === "false" ? false : value;
  }
  if (source["FMCAD_QUEUE_CLIENT"] !== undefined)
    queue["client"] = source["FMCAD_QUEUE_CLIENT"];
  if (Object.keys(queue).length > 0) environment["queue"] = queue;

  const port = environment["controlCenterPort"];
  if (port !== undefined) environment["controlCenter"] = { port };
  delete environment["controlCenterPort"];
  return environment;
}

function normalizeOptions(options: RecordValue): RecordValue {
  const adapter: RecordValue = {};
  for (const key of [
    "backend",
    "url",
    "endpoint",
    "headers",
    "tool",
    "transport",
    "protocolVersion",
    "routing",
    "queue",
  ] as const) {
    if (Object.hasOwn(options, key)) adapter[key] = options[key];
  }
  if (Object.hasOwn(options, "timeoutMs"))
    adapter["timeoutMs"] = parsedNumber(options["timeoutMs"]);
  else if (Object.hasOwn(options, "timeout"))
    adapter["timeout"] = parsedNumber(options["timeout"]);
  if (Object.hasOwn(options, "curlPath"))
    adapter["curlPath"] = options["curlPath"];
  else if (Object.hasOwn(options, "curl-path"))
    adapter["curl-path"] = options["curl-path"];

  const controlCenter = Object.hasOwn(options, "controlCenter")
    ? { ...asRecord(options["controlCenter"], "controlCenter") }
    : {};
  for (const key of ["controlCenterPort", "control-center-port"] as const) {
    if (!Object.hasOwn(options, key)) continue;
    const port = parsedNumber(options[key]);
    if (
      Object.hasOwn(controlCenter, "port") &&
      controlCenter["port"] !== port
    ) {
      throw new Error("controlCenter.port aliases conflict");
    }
    controlCenter["port"] = port;
  }
  if (Object.keys(controlCenter).length > 0)
    adapter["controlCenter"] = controlCenter;
  return adapter;
}

function readAcceptedService(): unknown {
  const file = acceptedServicePath();
  if (!existsSync(file)) return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`Cannot read accepted fmcad service configuration ${file}`);
  }
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new Error(
      `Cannot parse accepted fmcad service configuration ${file}: Invalid JSON`,
    );
  }
}

export function readConfigSources(input: unknown = {}): NodeConfigSources {
  const options = asRecord(input, "config options");
  const configPath = selectedConfigPath(options);
  const file = parseConfigFile(configPath, "config") ?? {};
  const isWsl =
    process.platform === "linux" && Boolean(process.env["WSL_DISTRO_NAME"]);
  const platformDefaults: RecordValue = isWsl
    ? {
        addinTransport: "windows-curl",
        addinCurlPath: "/mnt/c/Windows/System32/curl.exe",
      }
    : {};
  const adapter = normalizeOptions(options);
  return {
    path: configPath,
    adapter: adapter as ConfigLayer,
    environment: readEnvironment() as ConfigLayer,
    file,
    platformDefaults,
    acceptedService: readAcceptedService(),
  };
}

function importedBlock(document: RecordValue): RecordValue | null {
  const mcp = document["mcp"];
  if (!isRecord(mcp)) return null;
  if (isRecord(mcp["fusion"])) return mcp["fusion"];
  const servers = mcp["servers"];
  if (isRecord(servers) && isRecord(servers["fusion"]))
    return servers["fusion"];
  return null;
}

function firstAlias(
  source: RecordValue,
  primary: string,
  aliases: readonly string[],
  field: string,
): unknown {
  const keys = [primary, ...aliases].filter((key) =>
    Object.hasOwn(source, key),
  );
  if (keys.length > 1 && keys.some((key) => source[key] !== source[keys[0]!])) {
    throw new Error(`${field} aliases conflict`);
  }
  return keys.length > 0 ? source[keys[0]!] : undefined;
}

function importedTransport(block: RecordValue): "node" | "windows-curl" {
  const kind = block["type"];
  if (kind === "local" || kind === "stdio" || Object.hasOwn(block, "command")) {
    throw new Error(
      "OpenCode Fusion entry is a local/stdio MCP server; only a remote HTTP(S) endpoint can be imported",
    );
  }
  const transport = block["transport"] ?? kind;
  if (
    transport === undefined ||
    transport === "remote" ||
    transport === "http" ||
    transport === "https" ||
    transport === "node" ||
    transport === "fetch" ||
    transport === "sse"
  ) {
    return "node";
  }
  if (transport === "windows-curl" || transport === "curl")
    return "windows-curl";
  throw new Error(
    "OpenCode Fusion entry uses an unsupported transport; configure node or windows-curl explicitly",
  );
}

function importOpenCodeFusion(): {
  readonly file: string;
  readonly backend: RecordValue;
} {
  for (const parts of OPENCODE_CONFIGS) {
    const file = join(homedir(), ...parts);
    const document = parseConfigFile(file, "OpenCode");
    if (!document) continue;
    const block = importedBlock(document);
    if (!block) continue;
    const transport = importedTransport(block);
    const url = firstAlias(block, "url", ["endpoint"], "OpenCode MCP fusion");
    if (typeof url !== "string" || url.trim() === "") {
      throw new Error(
        "OpenCode Fusion entry must define a remote url or endpoint",
      );
    }
    const headersValue = block["headers"] ?? {};
    if (
      !isRecord(headersValue) ||
      Object.entries(headersValue).some(
        ([name, value]) => !HEADER_NAME.test(name) || typeof value !== "string",
      )
    ) {
      throw new Error(
        "OpenCode Fusion headers must be an object of string values",
      );
    }
    const timeout = firstAlias(
      block,
      "timeoutMs",
      ["timeout"],
      "OpenCode MCP fusion",
    );
    if (
      timeout !== undefined &&
      (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
    ) {
      throw new Error(
        "OpenCode Fusion timeout must be a positive number of milliseconds",
      );
    }
    const protocolVersion = firstAlias(
      block,
      "protocolVersion",
      ["protocol_version"],
      "OpenCode MCP fusion",
    );
    const curlPath = firstAlias(
      block,
      "curlPath",
      ["curl-path", "curl_path"],
      "OpenCode MCP fusion",
    );
    const tool = block["tool"];
    if (
      tool !== undefined &&
      (typeof tool !== "string" || tool.trim() === "")
    ) {
      throw new Error("OpenCode Fusion tool must be a nonempty string");
    }
    if (
      protocolVersion !== undefined &&
      (typeof protocolVersion !== "string" || protocolVersion.trim() === "")
    ) {
      throw new Error(
        "OpenCode Fusion protocolVersion must be a nonempty string",
      );
    }
    if (
      curlPath !== undefined &&
      (typeof curlPath !== "string" || curlPath.trim() === "")
    ) {
      throw new Error("OpenCode Fusion curlPath must be a nonempty string");
    }
    return {
      file,
      backend: {
        url,
        headers: headersValue,
        ...(timeout !== undefined ? { timeoutMs: timeout } : {}),
        ...(tool !== undefined ? { tool } : {}),
        transport,
        ...(curlPath !== undefined ? { curlPath } : {}),
        ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      },
    };
  }
  throw new Error(
    "no OpenCode MCP configuration with a remote Fusion endpoint found",
  );
}

export function prepareConfigInit(input: unknown = {}): ConfigInitPlan {
  const options = asRecord(input, "init options");
  const fromOpencode = options["fromOpencode"] === true;
  const force = options["force"] === true;
  const backendValue = options["backend"] ?? (fromOpencode ? "mcp" : "addin");
  if (backendValue !== "mcp" && backendValue !== "addin") {
    throw new Error('backend must be "mcp" or "addin"');
  }
  if (fromOpencode && backendValue !== "mcp") {
    throw new Error("--from-opencode is only compatible with the mcp backend");
  }
  const configPath = selectedConfigPath(options);
  if (existsSync(configPath) && !force) {
    throw new Error(
      `config already exists: ${configPath} (use --force to overwrite)`,
    );
  }

  let config: RecordValue = {
    backend: backendValue,
    routing: "queue",
    controlCenter: {},
  };
  let note = "safe defaults written";
  if (backendValue === "mcp") config["backends"] = { mcp: {} };
  if (fromOpencode) {
    const found = importOpenCodeFusion();
    config = {
      backend: "mcp",
      routing: "queue",
      controlCenter: {},
      backends: { mcp: found.backend },
    };
    note = `imported from ${found.file}`;
  }
  return {
    path: configPath,
    config,
    note,
    scriptsDir: join(dirname(configPath), "scripts"),
    imported: fromOpencode,
    force,
  };
}

export function writeConfigInitPlan(plan: ConfigInitPlan): {
  readonly path: string;
  readonly note: string;
} {
  mkdirSync(dirname(plan.path), { recursive: true });
  const temporary = join(
    dirname(plan.path),
    `.fmcad-config-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(plan.config, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    if (plan.force) renameSync(temporary, plan.path);
    else linkSync(temporary, plan.path);
    mkdirSync(plan.scriptsDir, { recursive: true });
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The atomic rename already consumed the temporary file.
    }
  }
  return {
    path: plan.path,
    note: `${plan.note}; scripts dir: ${plan.scriptsDir}`,
  };
}

export function writeAcceptedServiceConfiguration(
  input: AcceptedServiceConfiguration,
): void {
  if (
    input.version !== 1 ||
    !Number.isInteger(input.controlCenter.port) ||
    input.controlCenter.port < 1 ||
    input.controlCenter.port > 65535
  ) {
    throw new Error(
      "accepted service configuration must contain version 1 and a valid controlCenter.port",
    );
  }
  const file = acceptedServicePath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(file),
    `.accepted-service-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(input, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The atomic rename already consumed the temporary file.
    }
  }
}

export function acceptedServiceConfigurationPath(): string {
  return acceptedServicePath();
}
