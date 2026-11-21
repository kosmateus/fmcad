export type Backend = "mcp" | "addin";
export type Transport = "node" | "windows-curl";
export type ConfigLayer = Readonly<Record<string, unknown>>;

export interface QueueConfiguration {
  readonly autoStart?: boolean;
  readonly autoRecover?: boolean;
  readonly startupTimeoutMs?: number;
  readonly waitTimeoutMs?: number;
  readonly client?: string;
  /** Offline preparations; SDK mutations still use one lane. Omitted selects the CPU-aware default. */
  readonly preparationConcurrency?: number;
}

export interface FmcadConfiguration {
  readonly backend: Backend;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly tool: string;
  readonly transport: Transport;
  readonly curlPath?: string;
  readonly protocolVersion: string;
  readonly routing: "queue";
  readonly queue: QueueConfiguration;
  readonly controlCenter: { readonly port: number };
}

export interface AcceptedServiceConfiguration {
  readonly version: 1;
  readonly controlCenter: { readonly port: number };
}

export interface ConfigSources {
  readonly adapter: ConfigLayer;
  readonly environment: ConfigLayer;
  readonly file: ConfigLayer;
  readonly platformDefaults: ConfigLayer;
  readonly acceptedService: unknown;
}

export const DEFAULT_CONTROL_CENTER_PORT = 4748;

export const DEFAULT_ADDIN_SETTINGS = {
  url: "http://127.0.0.1:8765/mcp",
  headers: {},
  timeoutMs: 180000,
  tool: "execute_python",
  transport: "node",
  protocolVersion: "2025-06-18",
} as const;

const DEFAULTS = {
  backend: "addin",
  addin: DEFAULT_ADDIN_SETTINGS,
  mcp: {
    headers: {},
    timeoutMs: 180000,
    tool: "fusion_mcp_execute",
    transport: "node",
    protocolVersion: "2024-11-05",
  },
  routing: "queue",
} as const;

const ROOT_KEYS = new Set([
  "backend",
  "url",
  "endpoint",
  "headers",
  "timeoutMs",
  "timeout",
  "tool",
  "transport",
  "curlPath",
  "curl-path",
  "protocolVersion",
  "protocol_version",
  "routing",
  "queue",
  "controlCenter",
  "backends",
  "console",
]);

const CONSOLE_KEYS = new Set(["language", "color", "frames", "version"]);

const BACKEND_KEYS = new Set([
  "url",
  "endpoint",
  "headers",
  "timeoutMs",
  "timeout",
  "tool",
  "transport",
  "curlPath",
  "curl-path",
  "protocolVersion",
  "protocol_version",
]);

const QUEUE_KEYS = new Set([
  "autoStart",
  "autoRecover",
  "startupTimeoutMs",
  "waitTimeoutMs",
  "client",
  "preparationConcurrency",
]);

const ADAPTER_KEYS = new Set([
  "backend",
  "url",
  "endpoint",
  "headers",
  "timeoutMs",
  "timeout",
  "tool",
  "transport",
  "curlPath",
  "curl-path",
  "protocolVersion",
  "protocol_version",
  "routing",
  "queue",
  "controlCenter",
]);

const ENVIRONMENT_KEYS = new Set([
  "backend",
  "url",
  "endpoint",
  "headers",
  "timeoutMs",
  "timeout",
  "tool",
  "transport",
  "curlPath",
  "protocolVersion",
  "routing",
  "queue",
  "controlCenter",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${field}.${key} is not supported`);
  }
}

function aliasValue(
  value: Record<string, unknown>,
  primary: string,
  aliases: readonly string[],
  field: string,
): unknown {
  const found = [primary, ...aliases].filter((key) =>
    Object.hasOwn(value, key),
  );
  if (found.length > 1) {
    const first = value[found[0]!];
    if (found.some((key) => value[key] !== first)) {
      throw new Error(`${field}.${primary} aliases conflict`);
    }
  }
  return found.length ? value[found[0]!] : undefined;
}

function validateFileShape(fileValue: ConfigLayer): Record<string, unknown> {
  const file = record(fileValue, "config");
  rejectUnknownKeys(file, ROOT_KEYS, "config");

  if (Object.hasOwn(file, "backends")) {
    const backends = record(file["backends"], "backends");
    rejectUnknownKeys(backends, new Set(["mcp", "addin"]), "backends");
    for (const backend of ["mcp", "addin"] as const) {
      if (Object.hasOwn(backends, backend)) {
        const profile = record(backends[backend], `backends.${backend}`);
        rejectUnknownKeys(profile, BACKEND_KEYS, `backends.${backend}`);
        aliasValue(profile, "url", ["endpoint"], `backends.${backend}`);
        aliasValue(profile, "timeoutMs", ["timeout"], `backends.${backend}`);
        aliasValue(profile, "curlPath", ["curl-path"], `backends.${backend}`);
        aliasValue(
          profile,
          "protocolVersion",
          ["protocol_version"],
          `backends.${backend}`,
        );
      }
    }
  }

  aliasValue(file, "url", ["endpoint"], "config");
  aliasValue(file, "timeoutMs", ["timeout"], "config");
  aliasValue(file, "curlPath", ["curl-path"], "config");
  aliasValue(file, "protocolVersion", ["protocol_version"], "config");

  if (Object.hasOwn(file, "queue")) {
    const queue = record(file["queue"], "queue");
    rejectUnknownKeys(queue, QUEUE_KEYS, "queue");
  }
  if (Object.hasOwn(file, "controlCenter")) {
    const controlCenter = record(file["controlCenter"], "controlCenter");
    rejectUnknownKeys(controlCenter, new Set(["port"]), "controlCenter");
  }
  if (Object.hasOwn(file, "console")) {
    const preferences = record(file["console"], "console");
    rejectUnknownKeys(preferences, CONSOLE_KEYS, "console");
  }
  return file;
}

function valueFrom(
  layer: ConfigLayer,
  key: string,
  aliases: readonly string[] = [],
): unknown {
  return aliasValue(layer, key, aliases, "configuration");
}

function validateBackend(value: unknown): Backend {
  if (value !== "mcp" && value !== "addin") {
    throw new Error('backend must be "mcp" or "addin"');
  }
  return value;
}

function validatePort(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535
  ) {
    throw new Error(`${field} must be an integer from 1 to 65535`);
  }
  return value;
}

function sourcePort(
  layerValue: ConfigLayer,
  source: string,
): number | undefined {
  if (!Object.hasOwn(layerValue, "controlCenter")) return undefined;
  const controlCenter = record(
    layerValue["controlCenter"],
    `${source}.controlCenter`,
  );
  rejectUnknownKeys(
    controlCenter,
    new Set(["port"]),
    `${source}.controlCenter`,
  );
  if (!Object.hasOwn(controlCenter, "port")) return undefined;
  return validatePort(controlCenter["port"], `${source}.controlCenter.port`);
}

export function decodeAcceptedServiceConfiguration(
  input: unknown,
): AcceptedServiceConfiguration | null {
  if (input === null || input === undefined) return null;
  const accepted = record(input, "accepted service configuration");
  rejectUnknownKeys(
    accepted,
    new Set(["version", "controlCenter"]),
    "accepted service configuration",
  );
  if (accepted["version"] !== 1)
    throw new Error("accepted service configuration version must be 1");
  const controlCenter = record(
    accepted["controlCenter"],
    "accepted service configuration.controlCenter",
  );
  rejectUnknownKeys(
    controlCenter,
    new Set(["port"]),
    "accepted service configuration.controlCenter",
  );
  return {
    version: 1,
    controlCenter: {
      port: validatePort(
        controlCenter["port"],
        "accepted service configuration.controlCenter.port",
      ),
    },
  };
}

function readString(value: unknown, field: string, allowEmpty = false): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim() === "") ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error(
      `${field} must be ${allowEmpty ? "a string" : "a nonempty string"}`,
    );
  }
  return value;
}

function readHeaders(value: unknown, field: string): Record<string, string> {
  const source = record(value, field);
  const headers: [string, string][] = [];
  for (const [name, headerValue] of Object.entries(source)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      typeof headerValue !== "string" ||
      /[^\t\x20-\x7e\x80-\xff]/.test(headerValue)
    ) {
      throw new Error(
        `${field} must contain valid HTTP header names and string values`,
      );
    }
    headers.push([name, headerValue]);
  }
  return Object.fromEntries(headers);
}

function mergeHeaders(...sources: readonly unknown[]): Record<string, string> {
  const merged = new Map<string, { name: string; value: string }>();
  for (const [index, source] of sources.entries()) {
    if (source === undefined) continue;
    for (const [name, value] of Object.entries(
      readHeaders(source, `headers source ${index + 1}`),
    )) {
      merged.set(name.toLowerCase(), { name, value });
    }
  }
  return Object.fromEntries(
    [...merged.values()].map(({ name, value }) => [name, value]),
  );
}

function backendProfile(
  file: Record<string, unknown>,
  backend: Backend,
): {
  selected: ConfigLayer;
  legacy: ConfigLayer;
} {
  const backends = Object.hasOwn(file, "backends")
    ? record(file["backends"], "backends")
    : {};
  const selected = Object.hasOwn(backends, backend)
    ? record(backends[backend], `backends.${backend}`)
    : {};
  const legacy = backend === "mcp" ? file : {};
  return { selected, legacy };
}

function profileValue(profile: ConfigLayer, key: string): unknown {
  switch (key) {
    case "url":
      return valueFrom(profile, "url", ["endpoint"]);
    case "timeoutMs":
      return valueFrom(profile, "timeoutMs", ["timeout"]);
    case "curlPath":
      return valueFrom(profile, "curlPath", ["curl-path"]);
    case "protocolVersion":
      return valueFrom(profile, "protocolVersion", ["protocol_version"]);
    default:
      return profile[key];
  }
}

function profileField(
  adapter: ConfigLayer,
  environment: ConfigLayer,
  selected: ConfigLayer,
  legacy: ConfigLayer,
  defaults: ConfigLayer,
  field: string,
): unknown {
  const aliases =
    field === "url"
      ? ["endpoint"]
      : field === "timeoutMs"
        ? ["timeout"]
        : field === "curlPath"
          ? ["curl-path"]
          : field === "protocolVersion"
            ? ["protocol_version"]
            : [];
  return (
    valueFrom(adapter, field, aliases) ??
    valueFrom(environment, field, aliases) ??
    profileValue(selected, field) ??
    profileValue(legacy, field) ??
    defaults[field]
  );
}

interface ParsedEndpoint {
  readonly protocol: "http:" | "https:";
  readonly hostname: string;
  readonly port: number;
  readonly loopback: boolean;
}

function ipv4Number(component: string): number | null {
  let value: number;
  if (/^0x[\da-f]+$/i.test(component))
    value = Number.parseInt(component.slice(2), 16);
  else if (/^0[0-7]+$/.test(component))
    value = Number.parseInt(component.slice(1), 8);
  else if (/^(?:0|[1-9]\d*)$/.test(component)) value = Number(component);
  else return null;
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff
    ? value
    : null;
}

function isLoopbackIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length < 1 || parts.length > 4) return false;
  const values: number[] = [];
  for (const part of parts) {
    const value = ipv4Number(part);
    if (value === null) return false;
    values.push(value);
  }
  if (values.slice(0, -1).some((value) => value > 255)) return false;
  const lastLimit = 256 ** (5 - values.length);
  if (values[values.length - 1]! >= lastLimit) return false;
  let address = values[values.length - 1]!;
  for (let index = 0; index < values.length - 1; index++) {
    address += values[index]! * 256 ** (3 - index);
  }
  return Math.floor(address / 0x1000000) === 127;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    host === "localhost" ||
    host === "localhost." ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    isLoopbackIpv4(host)
  );
}

function parseEndpoint(text: string): ParsedEndpoint | null {
  if (/\s|\\|%(?![0-9a-f]{2})/i.test(text)) return null;
  const match = /^(https?):\/\/([^/?#]+)(?:[/?#][^#]*)?(?:#.*)?$/i.exec(text);
  if (!match) return null;
  const protocol = match[1]!.toLowerCase() === "https" ? "https:" : "http:";
  const authority = match[2]!;
  if (authority.includes("@")) return null;

  let hostname: string;
  let portText: string | undefined;
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]");
    if (closing < 0) return null;
    hostname = authority.slice(1, closing).toLowerCase();
    const remainder = authority.slice(closing + 1);
    if (remainder && !remainder.startsWith(":")) return null;
    portText = remainder ? remainder.slice(1) : undefined;
    if (!/^[0-9a-f:.]+$/.test(hostname)) return null;
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) {
      if (authority.indexOf(":") !== colon) return null;
      hostname = authority.slice(0, colon).toLowerCase();
      portText = authority.slice(colon + 1);
    } else {
      hostname = authority.toLowerCase();
    }
    if (!/^[a-z0-9.-]+$/.test(hostname)) return null;
  }
  if (!hostname || (portText !== undefined && !/^\d+$/.test(portText)))
    return null;
  const port =
    portText === undefined
      ? protocol === "https:"
        ? 443
        : 80
      : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return {
    protocol,
    hostname,
    port,
    loopback: isLoopbackHost(hostname),
  };
}

function validateUrl(
  value: unknown,
  backend: Backend,
  controlCenterPort: number,
): string {
  const text = readString(
    value,
    backend === "mcp" ? "backends.mcp.url" : "backends.addin.url",
  );
  const endpoint = parseEndpoint(text);
  if (!endpoint || text !== text.trim()) {
    throw new Error("url must be an absolute HTTP(S) URL");
  }
  const queryStart = text.indexOf("?");
  const fragmentStart = text.indexOf("#");
  if (queryStart >= 0 && (fragmentStart < 0 || queryStart < fragmentStart)) {
    const query = text.slice(
      queryStart + 1,
      fragmentStart < 0 ? undefined : fragmentStart,
    );
    for (const entry of query.split("&")) {
      const rawName = entry.split("=", 1)[0] ?? "";
      let name = rawName;
      try {
        name = decodeURIComponent(rawName.replaceAll("+", " "));
      } catch {
        throw new Error("url contains an invalid query string");
      }
      if (
        /^(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|key|secret|password|signature|sig|credential)$/i.test(
          name,
        )
      ) {
        throw new Error(
          "url must not contain secret query parameters; configure authentication headers",
        );
      }
    }
  }
  if (backend === "addin" && !endpoint.loopback)
    throw new Error("addin url must use a loopback host");
  if (
    endpoint.loopback &&
    (endpoint.port === controlCenterPort ||
      endpoint.port === DEFAULT_CONTROL_CENTER_PORT)
  ) {
    throw new Error(
      "url points to the fmcad Control Center; configure the Fusion add-in endpoint instead",
    );
  }
  return text;
}

function mergeQueue(sources: readonly ConfigLayer[]): QueueConfiguration {
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    if (!Object.hasOwn(source, "queue")) continue;
    const queue = record(source["queue"], "queue");
    rejectUnknownKeys(queue, QUEUE_KEYS, "queue");
    Object.assign(merged, queue);
  }
  if (
    merged["autoStart"] !== undefined &&
    typeof merged["autoStart"] !== "boolean"
  ) {
    throw new Error("queue.autoStart must be boolean");
  }
  if (
    merged["autoRecover"] !== undefined &&
    typeof merged["autoRecover"] !== "boolean"
  ) {
    throw new Error("queue.autoRecover must be boolean");
  }
  for (const key of ["startupTimeoutMs", "waitTimeoutMs"] as const) {
    const value = merged[key];
    if (
      value !== undefined &&
      (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        (key === "startupTimeoutMs" && value > 600000))
    ) {
      throw new Error(
        key === "startupTimeoutMs"
          ? "queue.startupTimeoutMs must be 1..600000"
          : "queue.waitTimeoutMs must be a positive safe integer",
      );
    }
  }
  const preparationConcurrency = merged["preparationConcurrency"];
  if (
    preparationConcurrency !== undefined &&
    (typeof preparationConcurrency !== "number" ||
      !Number.isSafeInteger(preparationConcurrency) ||
      preparationConcurrency < 1 ||
      preparationConcurrency > 10)
  ) {
    throw new Error(
      "queue.preparationConcurrency must be an integer from 1 to 10",
    );
  }
  if (merged["client"] !== undefined)
    merged["client"] = readString(merged["client"], "queue.client");
  return merged as QueueConfiguration;
}

export function resolveFmcadConfiguration(
  sources: ConfigSources,
): FmcadConfiguration {
  const adapter = record(sources.adapter, "adapter configuration");
  const environment = record(sources.environment, "environment configuration");
  rejectUnknownKeys(adapter, ADAPTER_KEYS, "adapter configuration");
  rejectUnknownKeys(environment, ENVIRONMENT_KEYS, "environment configuration");
  const file = validateFileShape(sources.file);
  const platformDefaults = record(
    sources.platformDefaults,
    "platform defaults",
  );
  const accepted = decodeAcceptedServiceConfiguration(sources.acceptedService);

  const backend = validateBackend(
    valueFrom(adapter, "backend") ??
      valueFrom(environment, "backend") ??
      valueFrom(file, "backend") ??
      DEFAULTS.backend,
  );
  const { selected, legacy } = backendProfile(file, backend);
  const backendDefaults = DEFAULTS[backend];
  const platformTransport =
    backend === "addin" ? platformDefaults["addinTransport"] : undefined;
  const platformCurlPath =
    backend === "addin" ? platformDefaults["addinCurlPath"] : undefined;
  const defaults: ConfigLayer = {
    ...backendDefaults,
    ...(platformTransport !== undefined
      ? { transport: platformTransport }
      : {}),
    ...(platformCurlPath !== undefined ? { curlPath: platformCurlPath } : {}),
  };

  const sourcePorts = [
    sourcePort(adapter, "adapter"),
    sourcePort(environment, "environment"),
    sourcePort(file, "config"),
  ].filter((port): port is number => port !== undefined);
  if (sourcePorts.some((port) => port !== sourcePorts[0])) {
    throw new Error(
      "controlCenter.port conflicts between shared-service configuration sources",
    );
  }
  const explicitPort = sourcePorts[0];
  const acceptedPort = accepted?.controlCenter.port;
  if (
    explicitPort !== undefined &&
    acceptedPort !== undefined &&
    explicitPort !== acceptedPort
  ) {
    throw new Error(
      "controlCenter.port conflicts with the last verified fmcad service configuration",
    );
  }
  const port = validatePort(
    explicitPort ?? acceptedPort ?? DEFAULT_CONTROL_CENTER_PORT,
    "controlCenter.port",
  );

  const url = validateUrl(
    profileField(adapter, environment, selected, legacy, defaults, "url"),
    backend,
    port,
  );
  const headers = mergeHeaders(
    legacy["headers"],
    selected["headers"],
    environment["headers"],
    adapter["headers"],
  );
  const timeoutMs = profileField(
    adapter,
    environment,
    selected,
    legacy,
    defaults,
    "timeoutMs",
  );
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new Error("timeoutMs must be a finite number greater than zero");
  }
  const tool = readString(
    profileField(adapter, environment, selected, legacy, defaults, "tool"),
    "tool",
  );
  const transportValue = profileField(
    adapter,
    environment,
    selected,
    legacy,
    defaults,
    "transport",
  );
  if (transportValue !== "node" && transportValue !== "windows-curl") {
    throw new Error('transport must be "node" or "windows-curl"');
  }
  const curlPathValue = profileField(
    adapter,
    environment,
    selected,
    legacy,
    defaults,
    "curlPath",
  );
  const curlPath =
    curlPathValue === undefined
      ? undefined
      : readString(curlPathValue, "curlPath");
  const protocolVersion = readString(
    profileField(
      adapter,
      environment,
      selected,
      legacy,
      defaults,
      "protocolVersion",
    ),
    "protocolVersion",
  );
  if (transportValue === "windows-curl") {
    if (!parseEndpoint(url)?.loopback)
      throw new Error("windows-curl requires an HTTP(S) loopback URL");
    if (timeoutMs > 2147483647)
      throw new Error("windows-curl timeoutMs must not exceed 2147483647");
  }

  const routing =
    valueFrom(adapter, "routing") ??
    valueFrom(environment, "routing") ??
    valueFrom(file, "routing") ??
    DEFAULTS.routing;
  if (routing !== "queue") {
    throw Object.assign(
      new Error(
        'routing is fixed to "queue"; routing=direct is no longer supported. Use the shared fmcad broker.',
      ),
      { code: "UNSUPPORTED_ROUTING" },
    );
  }

  const queue = mergeQueue([file, environment, adapter]);
  return {
    backend,
    url,
    headers,
    timeoutMs,
    tool,
    transport: transportValue,
    ...(curlPath !== undefined ? { curlPath } : {}),
    protocolVersion,
    routing: "queue",
    queue,
    controlCenter: { port },
  };
}
