import * as fs from "node:fs";
import path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
const runtimeRequire = createRequire(__filename);
const { queueDirectory, request } = runtimeRequire("./queue-connection") as {
  queueDirectory(): string;
  request(dir: string, message: Record<string, unknown>): Promise<unknown>;
};
interface Config {
  routing?: string;
  backend?: string;
  timeoutMs?: number;
  queue?: { autoStart?: boolean; client?: string; waitTimeoutMs?: number };
}
interface Options {
  existingCredentialsOnly?: boolean;
  instanceId?: string;
  cfg?: Config;
  configPath?: string;
}
interface Job {
  id: string;
  requestId: string;
  clientId: string;
  state: string;
}
interface Result {
  job: Job;
  stdout?: string;
  stderr?: string;
  pythonChecks?: unknown[];
  execution?: { pythonCheck?: unknown };
  outputs?: unknown;
}
interface Input extends Record<string, unknown> {
  kind?: string;
  argv?: string[];
  requestId?: string;
  cwd?: string;
}
interface Command {
  key: string;
  target?: string;
  kind: string;
  flags: Record<string, string>;
  aliases?: string[];
}
interface Commands {
  findCommand(argv: string[]): Command | undefined;
  globalFlags: Record<string, string>;
}
interface Flags {
  opts: Record<string, string>;
  rest: string[];
}
interface ContextSelection {
  roots?: unknown;
  projectDirectory?: unknown;
}
interface BrokerStatus {
  features?: { conditionalIdleStop?: boolean };
  jobs?: Record<string, Job>;
  active?: unknown;
  blocked?: unknown;
  held?: unknown;
  lease?: unknown;
  stopping?: boolean;
  buildHash: string;
  revision: number;
  control?: { activeOperations?: number; phase?: string; instanceId?: string };
}
const scripts = (): {
  resolveScript(name: string, options: Record<string, unknown>): string;
} => runtimeRequire("./run") as ReturnType<typeof scripts>;
const instance = (): {
  readJson(file: string): { nonce?: string };
  buildHash(): string;
} => runtimeRequire("./queue-instance") as ReturnType<typeof instance>;
const commands = (): Commands => runtimeRequire("./commands") as Commands;
const flags = (argv: string[]): Flags =>
  (runtimeRequire("./cli") as { parseFlags(argv: string[]): Flags }).parseFlags(
    argv,
  );
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected queue record");
  return value as Record<string, unknown>;
}
function readJson(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  return record(value);
}
function jobResult(value: unknown): Result {
  const result = record(value),
    job = record(result["job"]);
  for (const key of ["id", "requestId", "clientId", "state"]) {
    if (typeof job[key] !== "string")
      throw new Error("Invalid queue result identity");
  }
  for (const key of ["stdout", "stderr"]) {
    if (result[key] !== undefined && typeof result[key] !== "string")
      throw new Error("Invalid queue output");
  }
  return value as Result;
}
function config(): {
  loadConfig(options: Record<string, unknown>): { cfg: Config };
} {
  return runtimeRequire("./config") as ReturnType<typeof config>;
}

const hash = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 256;
const final = (state: string): boolean =>
  [
    "succeeded",
    "failed",
    "cancelled",
    "expired",
    "needs_reconciliation",
  ].includes(state);
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function requestContextPath(
  dir: string,
  clientId: string,
  requestId: string,
): string {
  return path.join(
    dir,
    "client-credentials",
    hash(clientId) + "-" + hash(requestId) + ".mcp-context.json",
  );
}

function readRequestContextFile(
  file: string,
  clientId: string,
  requestId: string,
): Record<string, unknown> {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024)
      throw new Error("Invalid private MCP request context record");
    const value = readJson(fs.readFileSync(fd, "utf8"));
    if (
      value["version"] !== 1 ||
      value["clientId"] !== clientId ||
      value["requestId"] !== requestId ||
      !value["context"] ||
      typeof value["context"] !== "object"
    ) {
      throw new Error(
        "Invalid private MCP request context record; preserve it for inspection",
      );
    }
    return record(value["context"]);
  } finally {
    fs.closeSync(fd);
  }
}

function credentials(
  clientId = process.env["FMCAD_CLIENT"] ||
    `cli:${os.hostname()}:${os.userInfo().username}`,
  existingOnly = false,
): { clientId: string; clientToken: string } {
  if (typeof clientId !== "string" || !clientId.trim() || clientId.length > 256)
    throw new Error("client id must contain 1..256 characters");
  const dir = queueDirectory();
  const clients = path.join(dir, "client-credentials");
  if (!existingOnly) fs.mkdirSync(clients, { recursive: true, mode: 0o700 });
  const file = path.join(clients, hash(clientId) + ".json");
  const temporary = path.join(clients, "." + randomUUID() + ".tmp");
  if (!existingOnly)
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({
            clientId,
            clientToken: randomBytes(32).toString("hex"),
          }),
        );
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // Publish a fully written credential without replacing an existing owner.
      try {
        fs.linkSync(temporary, file);
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      }
      const directory = fs.openSync(clients, "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let auth: Record<string, unknown>;
  try {
    auth = readJson(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
  if (
    auth["clientId"] !== clientId ||
    typeof auth["clientToken"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(auth["clientToken"])
  )
    throw new Error(
      "Invalid private queue client credentials; do not replace credentials of an existing sequence",
    );
  return { clientId, clientToken: auth["clientToken"] };
}

function defaultMcpClientId() {
  return `mcp-stdio:${os.hostname()}:${os.userInfo().username}`;
}

function resolveMcpProjectDirectory(selection: ContextSelection = {}) {
  const directory = (value: unknown, label: string, uri = false): string => {
    if (typeof value !== "string" || !value.trim() || value.length > 4096) {
      throw new Error(`${label} must contain 1..4096 characters`);
    }
    let candidate = value;
    if (uri) {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error(`${label} must be a local file URI`);
      }
      if (parsed.protocol !== "file:")
        throw new Error(`${label} must be a local file URI`);
      try {
        candidate = fileURLToPath(parsed);
      } catch {
        throw new Error(`${label} must be a local file URI`);
      }
    }
    if (!path.isAbsolute(candidate))
      throw new Error(`${label} must be an absolute directory`);
    const resolved = fs.realpathSync(candidate);
    if (!fs.statSync(resolved).isDirectory())
      throw new Error(`${label} must resolve to a directory`);
    return resolved;
  };
  const roots = selection.roots ?? [];
  if (!Array.isArray(roots) || roots.length > 32)
    throw new Error("roots must contain at most 32 validated file roots");
  const canonicalRoots = roots.map((raw: unknown, index: number) => {
    const root =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    if (
      !root ||
      Object.keys(root).some((key) => !["uri", "name"].includes(key)) ||
      typeof root["uri"] !== "string" ||
      (root["name"] !== undefined && typeof root["name"] !== "string")
    ) {
      throw new Error(
        `roots[${index}] must contain only a file URI and optional name`,
      );
    }
    return directory(root["uri"], `roots[${index}].uri`, true);
  });
  const uniqueRoots = [...new Set(canonicalRoots)];
  let projectDirectory: string | null = null;
  let source = "none";
  if (
    selection.projectDirectory !== undefined &&
    selection.projectDirectory !== null
  ) {
    projectDirectory = directory(
      selection.projectDirectory,
      "projectDirectory",
    );
    source = "explicit";
  } else if (uniqueRoots.length === 1) {
    projectDirectory = uniqueRoots[0]!;
    source = "root";
  } else if (uniqueRoots.length > 1) {
    throw new Error(
      "Multiple MCP roots are hints only; select projectDirectory explicitly",
    );
  }
  if (
    projectDirectory &&
    uniqueRoots.length &&
    !uniqueRoots.some((root) => {
      const relative = path.relative(root, projectDirectory);
      return (
        relative === "" ||
        (!relative.startsWith(`..${path.sep}`) &&
          relative !== ".." &&
          !path.isAbsolute(relative))
      );
    })
  ) {
    throw new Error(
      "projectDirectory must be inside one of the validated MCP roots",
    );
  }
  return { projectDirectory, source };
}

class QueueClient {
  readonly dir: string;
  readonly auth: { clientId: string; clientToken: string };
  readonly options: Options;
  private clientPresence: { dispose(): void } | null;
  readonly instanceId: string;
  readonly exitHandler: () => void;
  private registered = false;
  constructor(clientId?: string, options: Options = {}) {
    this.dir = queueDirectory();
    this.auth = credentials(clientId, options.existingCredentialsOnly === true);
    this.options = options;
    this.clientPresence = null;
    this.instanceId = options.instanceId || randomUUID();
    this.exitHandler = () => this.dispose();
    process.once("exit", this.exitHandler);
  }
  async register({ autoStart = false } = {}) {
    try {
      await request(this.dir, { action: "register", ...this.auth });
    } catch (error) {
      const { ensureBroker, missing } = runtimeRequire("./queue-autostart") as {
        ensureBroker(
          cfg: Config,
          auth: { clientId: string; clientToken: string },
        ): Promise<unknown>;
        missing(error: unknown): boolean;
      };
      if (!autoStart || !missing(error)) throw error;
      const selected = this.options.cfg;
      if (!selected || selected.routing !== "queue") throw error;
      if (selected.queue?.autoStart === false) {
        throw Object.assign(
          new Error(
            "Queue broker is not running and queue.autoStart is false; no direct fallback",
          ),
          { code: "QUEUE_NOT_RUNNING" },
        );
      }
      // Startup uses the configured physical backend, not this job's execution
      // --timeout or per-job connection overrides. Other callers share it.
      const base = config().loadConfig({
        config: this.options.configPath,
        routing: "queue",
      }).cfg;
      if (selected.backend !== base.backend) {
        throw Object.assign(
          new Error(
            `Queue broker is configured for ${base.backend}; this client requests ${selected.backend}. Select the configured backend; no broker was launched.`,
          ),
          { code: "BACKEND_MISMATCH" },
        );
      }
      await ensureBroker(base, this.auth);
    }
    this.registered = true;
    return this;
  }
  call(action: string, values: Record<string, unknown> = {}): Promise<unknown> {
    const input = values["request"];
    if (
      action === "submit" &&
      this.registered &&
      input &&
      typeof input === "object" &&
      "cwd" in input &&
      typeof input.cwd === "string" &&
      !this.clientPresence
    ) {
      try {
        this.clientPresence = (
          runtimeRequire("./client-presence") as {
            startClientPresence(
              client: string,
              cwd: string,
              options: { instanceId: string },
            ): { dispose(): void };
          }
        ).startClientPresence(this.auth.clientId, input.cwd, {
          instanceId: this.instanceId,
        });
      } catch {
        /* Passive telemetry cannot change admission/execution outcomes. */
      }
    }
    return request(this.dir, { ...values, action, auth: this.auth });
  }
  async findRequest(requestId: string) {
    if (
      typeof requestId !== "string" ||
      !requestId.trim() ||
      requestId.length > 256
    ) {
      throw new Error("requestId must contain 1..256 characters");
    }
    const found = record(await this.readResult("find-request", { requestId }));
    const job = found["job"] ? record(found["job"]) : null;
    const context = this.readRequestContext(requestId);
    if (!job) return context === null ? null : { job: null, context };
    if (job["clientId"] !== this.auth.clientId)
      throw Object.assign(
        new Error("Broker returned a foreign request owner"),
        { code: "NOT_OWNER" },
      );
    return {
      ...record(await this.readResult("result", { jobId: job["id"] })),
      context,
    };
  }
  async readResult(
    action: string,
    values: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const recovery = runtimeRequire(
      "./dist/node-adapters/broker-ipc/response-recovery",
    ) as {
      readResult(
        client: QueueClient,
        action: string,
        values: Record<string, unknown>,
        signal?: AbortSignal,
      ): Promise<unknown>;
    };
    return recovery.readResult(this, action, values, signal);
  }
  submitAdmitted(input: Input): Promise<Job> {
    const recovery = runtimeRequire(
      "./dist/node-adapters/broker-ipc/response-recovery",
    ) as {
      submitWithRecovery(client: QueueClient, input: Input): Promise<Job>;
    };
    return recovery.submitWithRecovery(this, input);
  }
  persistRequestContext(requestId: string, context: Record<string, unknown>) {
    if (
      !identifier(requestId) ||
      !context ||
      typeof context !== "object" ||
      Array.isArray(context)
    ) {
      throw new Error("Invalid MCP request context");
    }
    const directory = path.join(this.dir, "client-credentials");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = requestContextPath(this.dir, this.auth.clientId, requestId);
    const record = {
      version: 1,
      clientId: this.auth.clientId,
      requestId,
      context,
    };
    const temporary = path.join(
      directory,
      "." + randomUUID() + ".mcp-context.tmp",
    );
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(record));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.linkSync(temporary, file);
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
        const existing = readRequestContextFile(
          file,
          this.auth.clientId,
          requestId,
        );
        if (!isDeepStrictEqual(existing, context)) {
          throw Object.assign(
            new Error("requestId already has different immutable MCP context"),
            { code: "REQUEST_CONTEXT_CONFLICT", notStarted: true },
          );
        }
      }
      const dirfd = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(dirfd);
      } finally {
        fs.closeSync(dirfd);
      }
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  readRequestContext(requestId: string) {
    if (!identifier(requestId))
      throw new Error("requestId must contain 1..256 characters");
    const file = requestContextPath(this.dir, this.auth.clientId, requestId);
    if (!fs.existsSync(file)) return null;
    return readRequestContextFile(file, this.auth.clientId, requestId);
  }
  dispose() {
    process.removeListener("exit", this.exitHandler);
    try {
      this.clientPresence?.dispose();
    } catch {
      /* Presence cleanup cannot change a queue result. */
    } finally {
      this.clientPresence = null;
    }
  }
  async submit(input: Input): Promise<Job> {
    if (input.kind === "command" && Array.isArray(input.argv)) {
      const entry = commands().findCommand(flags(input.argv).rest);
      if (
        ["queue", "init", "console"].includes(entry?.key.split(" ")[0] || "") ||
        entry?.target === "animation.play"
      ) {
        throw Object.assign(
          new Error(
            "This command is unsupported in the queue; no broker startup or direct fallback was attempted",
          ),
          { code: "unsupported_queue_route" },
        );
      }
    }
    await this.register({ autoStart: true });
    const value = { ...input, requestId: input.requestId || randomUUID() };
    const recovery = runtimeRequire(
      "./dist/node-adapters/broker-ipc/response-recovery",
    ) as {
      submitWithRecovery(
        client: QueueClient,
        value: Input,
        refresh: () => Promise<void>,
      ): Promise<Job>;
    };
    return recovery.submitWithRecovery(this, value, () =>
      refreshIdleBroker(this, value),
    );
  }
  async wait(
    jobId: string,
    {
      signal,
      progress,
    }: { signal?: AbortSignal; progress?: (job: Job) => void } = {},
  ): Promise<Result> {
    let previous: string | undefined;
    for (;;) {
      if (signal?.aborted)
        throw Object.assign(
          new Error(`Stopped waiting; job ${jobId} is NOT cancelled`),
          { code: "WAIT_ABORTED", jobId },
        );
      const value = jobResult(
        await this.readResult("result", { jobId }, signal),
      );
      const state = value.job.state;
      if (state !== previous) {
        progress?.(value.job);
        previous = state;
      }
      if (final(state)) return value;
      await delay(250);
    }
  }
}

async function refreshIdleBroker(
  client: QueueClient,
  input: Input,
  { waitStopped }: { waitStopped?: () => Promise<void> } = {},
): Promise<void> {
  const cfg = client.options.cfg;
  if (!cfg || cfg.routing !== "queue" || cfg.queue?.autoStart === false)
    throw Object.assign(
      new Error("Broker build changed; configured manual startup is preserved"),
      { code: "BUILD_CHANGED", notStarted: true },
    );
  const status = (await client.call("status")) as BrokerStatus;
  if (!status.features?.conditionalIdleStop)
    throw Object.assign(
      new Error("Older broker requires an explicit idle maintenance handoff"),
      { code: "BUILD_CHANGED", notStarted: true },
    );
  if (
    Object.values(status.jobs || {}).some(
      (job) => job.requestId === input.requestId,
    )
  )
    throw Object.assign(
      new Error(
        "Original request already exists; inspect its job instead of resubmitting",
      ),
      { code: "REQUEST_ALREADY_ADMITTED" },
    );
  if (
    status.active ||
    status.blocked ||
    status.held ||
    status.lease ||
    status.stopping ||
    status.control?.activeOperations ||
    status.control?.phase === "RESUMING" ||
    Object.values(status.jobs || {}).some(
      (job) =>
        !["succeeded", "failed", "cancelled", "expired"].includes(job.state),
    )
  ) {
    throw Object.assign(
      new Error(
        "Build reload waits for all original SDK/local work and leases to finish; no operation was submitted",
      ),
      { code: "BUILD_UPGRADE_BUSY", notStarted: true },
    );
  }
  await client.call("stop", {
    onlyIfQuiescent: true,
    expectedBuildHash: status.buildHash,
    expectedRevision: status.revision,
  });
  if (waitStopped) await waitStopped();
  else {
    const deadline = Date.now() + 15000,
      marker = path.join(client.dir, "broker.lock");
    while (fs.existsSync(marker) && Date.now() < deadline) {
      const current = instance().readJson(marker);
      if (current.nonce !== status.control?.instanceId) break; // Another caller already started the replacement.
      await delay(25);
    }
    if (
      fs.existsSync(marker) &&
      instance().readJson(marker).nonce === status.control?.instanceId
    )
      throw Object.assign(
        new Error(
          "Idle broker has not stopped; original request remains unsubmitted",
        ),
        { code: "BUILD_UPGRADE_BUSY", notStarted: true },
      );
  }
  await client.register({ autoStart: true });
}

function inputFiles(
  argv: string[],
  cwd: string,
  options: Record<string, unknown> = {},
) {
  const names = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    if (["--file", "--args-file"].includes(argv[i] || "") && argv[i + 1])
      names.add(path.resolve(cwd, argv[++i]!));
  }
  const position = runArgumentPosition(argv);
  if (position !== undefined)
    names.add(scripts().resolveScript(argv[position]!, options));
  return [...names].map((file) => ({
    path: file,
    sha256: hash(fs.readFileSync(file)),
  }));
}

function runArgumentPosition(argv: string[]): number | undefined {
  const { globalFlags, findCommand } = commands();
  const positions: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (Object.hasOwn(globalFlags, argv[i]!)) i++;
    else positions.push(i);
  }
  const words = positions.map((i) => argv[i]!);
  const entry = findCommand(words);
  if (entry?.kind !== "run" || words.includes("--list") || words.includes("-l"))
    return undefined;
  for (let i = 1; i < words.length; i++) {
    if (Object.hasOwn(entry.flags, words[i]!)) {
      if (entry.flags[words[i]!] === "value") i++;
      continue;
    }
    if (words[i]!.startsWith("-")) continue;
    return positions[i];
  }
  return undefined;
}

function pinCommand(argv: string[], options: Record<string, unknown> = {}) {
  const pinned = [...argv];
  const index = runArgumentPosition(argv);
  if (index !== undefined)
    pinned[index] = scripts().resolveScript(argv[index]!, options);
  return pinned;
}

function verifyInputBytes(file: string, bytes: Buffer) {
  if (!process.env["FMCAD_QUEUE_WORKER_JOB"]) return;
  const entries: unknown = JSON.parse(
    process.env["FMCAD_QUEUE_INPUT_FILES"] || "[]",
  );
  if (!Array.isArray(entries)) throw new Error("Invalid queue input files");
  const entry = entries
    .map((item: unknown) => record(item))
    .find(
      (item) =>
        typeof item["path"] === "string" &&
        path.resolve(item["path"]) === path.resolve(file),
    );
  if (!entry || entry["sha256"] !== hash(bytes))
    throw Object.assign(new Error("Queued input bytes changed: " + file), {
      code: "INPUT_CHANGED",
    });
}

function sequenceOptions(opts: Record<string, string | undefined>) {
  if (
    !opts["sequence-action"] &&
    !opts["sequence-id"] &&
    !opts["sequence-mode"]
  )
    return undefined;
  const value = {
    action: opts["sequence-action"],
    ...(opts["sequence-id"] ? { id: opts["sequence-id"] } : {}),
    ...(opts["sequence-mode"] ? { mode: opts["sequence-mode"] } : {}),
  };
  if (
    !value.action ||
    !["begin", "continue", "end"].includes(value.action) ||
    (value.action === "begin" ? value.id !== undefined : !value.id)
  )
    throw new Error(
      "Use --sequence-action begin, or continue/end with --sequence-id",
    );
  if (
    value.mode !== undefined &&
    !["automatic", "exclusive"].includes(value.mode)
  )
    throw new Error("sequence mode must be automatic or exclusive");
  return value;
}

async function runQueued(
  argv: string[],
  cfg: Config,
  opts: Record<string, string | undefined>,
  streams: {
    stdout: { write(text: string): unknown };
    stderr: { write(text: string): unknown };
    invocationContext?: { purpose?: string };
  },
) {
  const client = new QueueClient(
    opts["client"] ?? process.env["FMCAD_CLIENT"] ?? cfg.queue?.client,
    { cfg, ...(opts["config"] ? { configPath: opts["config"] } : {}) },
  );
  try {
    const requestId = opts["request-id"] || randomUUID();
    const pinned = pinCommand(argv, { config: opts["config"] });
    const input: Input = {
      requestId,
      kind: "command",
      argv: pinned,
      cwd: process.cwd(),
      timeoutMs: cfg.timeoutMs,
      backend: cfg.backend,
      inputFiles: inputFiles(pinned, process.cwd(), { config: opts["config"] }),
      buildHash: instance().buildHash(),
    };
    const invocation = runtimeRequire("./invocation") as {
      context: { getStore(): { description?: string } | undefined };
    };
    const purpose =
      opts["description"] ||
      streams.invocationContext?.purpose ||
      invocation.context.getStore()?.description;
    if (purpose) input["description"] = purpose;
    const sequence = sequenceOptions(opts);
    if (sequence) input["sequence"] = sequence;
    if (
      opts["queue-timeout"] !== undefined ||
      cfg.queue?.waitTimeoutMs !== undefined
    )
      input["queueTimeoutMs"] = Number(
        opts["queue-timeout"] ?? cfg.queue?.waitTimeoutMs,
      );
    if (opts["expected-revision"] !== undefined)
      input["expectedRevision"] = Number(opts["expected-revision"]);
    // Persist client-side intent before submission, so loss of the admission reply has a stable lookup key.
    const intent = path.join(
      client.dir,
      "client-credentials",
      hash(client.auth.clientId) + "-" + hash(requestId) + ".json",
    );
    if (!fs.existsSync(intent)) {
      const fd = fs.openSync(intent, "wx", 0o600);
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({ requestId, clientId: client.auth.clientId, input }),
        );
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    streams.stderr.write(
      "FMCAD_QUEUE_REQUEST " +
        JSON.stringify({ requestId, clientId: client.auth.clientId }) +
        "\n",
    );
    const job = await client.submit(input);
    streams.stderr.write(
      "FMCAD_QUEUE_JOB " + JSON.stringify({ jobId: job.id, requestId }) + "\n",
    );
    const result = await client.wait(job.id, {
      progress: (value) =>
        streams.stderr.write(`QUEUE ${value.id} ${value.state}\n`),
    });
    if (result.stdout) streams.stdout.write(result.stdout);
    if (result.stderr) streams.stderr.write(result.stderr);
    for (const report of result.pythonChecks ||
      (result.execution?.pythonCheck ? [result.execution.pythonCheck] : []))
      streams.stderr.write(
        "FMCAD_PYTHON_CHECK " + JSON.stringify(report) + "\n",
      );
    if (result.outputs)
      streams.stderr.write(
        "FMCAD_QUEUE_OUTPUTS " + JSON.stringify(result.outputs) + "\n",
      );
    streams.stderr.write(
      "FMCAD_QUEUE_RESULT " + JSON.stringify(result.job) + "\n",
    );
    return result.job.state === "succeeded" ? 0 : 1;
  } finally {
    client.dispose();
  }
}

function invocationRouting(argv: string[], cwd = process.cwd()) {
  argv = [...argv];
  for (let i = 0; i < argv.length; i++)
    if (
      ["--file", "--config", "--args-file"].includes(argv[i] || "") &&
      argv[i + 1]
    )
      argv[++i] = path.resolve(cwd, argv[i]!);
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help")
    return false;
  if (argv[0] === "queue") return ["exec", "submit"].includes(argv[1] || "");
  if (argv[0] === "image") return false;
  const { opts, rest } = flags(argv);
  const entry = commands().findCommand(rest);
  if (
    !entry ||
    ["local", "help", "family", "init"].includes(entry.kind) ||
    (entry.kind === "run" && (rest.includes("--list") || rest.includes("-l")))
  )
    return false;
  if (entry.kind === "cad") {
    interface Spec {
      inputs: unknown;
      offline?: boolean;
    }
    const { catalog } = runtimeRequire("./cad") as {
      catalog: Record<string, Spec>;
    };
    const spec = catalog[entry.target || ""];
    const spelling = [entry.key, ...(entry.aliases || [])]
      .sort((a, b) => b.length - a.length)
      .find((s) => rest.slice(0, s.split(" ").length).join(" ") === s);
    if (!spec || !spelling || !entry.target)
      throw new Error("Invalid CAD command specification");
    const input = (
      runtimeRequire("./cad-input") as {
        parseCadInput(
          argv: string[],
          inputs: unknown,
          spec: Spec,
        ): { preview?: boolean; data: Record<string, unknown> };
      }
    ).parseCadInput(rest.slice(spelling.split(" ").length), spec.inputs, spec);
    if (
      spec.offline ||
      input.preview ||
      ["batch.validate", "batch.preview"].includes(entry.target) ||
      (
        runtimeRequire("./data-import") as {
          isOffline(target: string, data: Record<string, unknown>): boolean;
        }
      ).isOffline(entry.target, input.data) ||
      (entry.target === "references.refresh" &&
        input.data["phase"] === "inspect") ||
      (entry.target === "definition.instantiate" &&
        input.data["mode"] &&
        input.data["mode"] !== "run")
    )
      return false;
  }
  return config().loadConfig(opts).cfg.routing === "queue";
}

export {
  QueueClient,
  runQueued,
  sequenceOptions,
  inputFiles,
  pinCommand,
  verifyInputBytes,
  credentials,
  defaultMcpClientId,
  resolveMcpProjectDirectory,
  final,
  invocationRouting,
  refreshIdleBroker,
};
