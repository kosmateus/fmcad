import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  CadWorkerInvocation,
  CatalogInvocation,
  FmcadConfiguration,
  FmcadOptions,
  JsonValue,
  OperationDeclaration,
} from "../api";
import { parseFlags, parseCommand, executionOptions } from "./cli/parser";
import type { CliOptions, CommandEntry } from "./cli/parser";
import {
  catalog,
  catalogInput,
  execute,
  receiptExitCode,
  assertBrokerRouting,
} from "./cli/application";
import type { CliApplicationPorts } from "./cli/application";
import { CliError, renderMessage } from "./cli/messages";

export { parseFlags, parseCommand } from "./cli/parser";
interface Sink {
  write(text: string): unknown;
  isTTY?: boolean;
  columns?: number;
}
interface CadInput extends Omit<
  CatalogInvocation,
  "version" | "kind" | "operation"
> {
  json?: boolean;
  summary?: boolean;
}
type LocalCommand = (argv: string[], deps: CliDependencies) => Promise<number>;
export interface CliDependencies extends CliApplicationPorts {
  stdout?: Sink;
  stderr?: Sink;
  setExitCode?: (code: number) => void;
  loadConfig?: (options: CliOptions) => { cfg: FmcadConfiguration };
  initConfig?: (options: Record<string, unknown>) => {
    path: string;
    note: string;
  };
  listScripts?: (options: {
    config?: string;
  }) => { name: string; dir: string }[];
  runQueued?: (
    argv: string[],
    cfg: FmcadConfiguration,
    opts: CliOptions,
    deps: CliDependencies,
  ) => Promise<number>;
}
interface Declarations {
  findCommand(argv: string[]): CommandEntry | undefined;
}
interface Help {
  detail(...words: string[]): string;
  globalHelp(): string;
}
interface InvocationStore {
  description?: string;
  label?: string;
  document?: string;
}
const invocation: {
  parseInvocation(argv: string[]): { argv: string[]; description?: string };
  context: AsyncLocalStorage<InvocationStore>;
} = require("../../invocation");
const commands: Declarations = require("../../commands");
const help: Help = require("../../help");
const configuration: Pick<
  Required<CliDependencies>,
  "loadConfig" | "initConfig"
> = require("../../config");

function stringOption(options: CliOptions, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}
function runPayload(
  name: string,
  flags: Record<string, string | boolean>,
  opts: CliOptions,
  readInput: (filename: string) => Buffer,
): CadWorkerInvocation {
  const payloadText =
    typeof flags["--args-file"] === "string"
      ? readInput(flags["--args-file"]).toString("utf8")
      : flags["--args"];
  const output = {
    ...(flags["--out"] === undefined ? {} : { path: flags["--out"] }),
    ...(flags["--out-format"] === undefined
      ? {}
      : { format: flags["--out-format"] }),
    ...(flags["--pretty"] === undefined
      ? {}
      : { pretty: flags["--pretty"] === "true" }),
  };
  const convert: {
    fromParsedCommand(
      command: unknown,
      options: unknown,
    ): { payload: CadWorkerInvocation };
  } = require("../../cad-service");
  return convert.fromParsedCommand(
    {
      kind: "run",
      request: {
        name,
        args:
          typeof payloadText === "string"
            ? (JSON.parse(payloadText) as unknown)
            : [],
        hasArgs: payloadText !== undefined,
        ...(flags["--doc"] === undefined ? {} : { doc: flags["--doc"] }),
        identity: {
          ...(flags["--doc-id"] === undefined
            ? {}
            : { docId: flags["--doc-id"] }),
          ...(flags["--doc-file-id"] === undefined
            ? {}
            : { docFileId: flags["--doc-file-id"] }),
          readOnly: flags["--readonly"] === true,
        },
        ...(flags["--helpers"] === undefined
          ? {}
          : { helperVersion: flags["--helpers"] }),
      },
      ...(opts.description === undefined ? {} : { purpose: opts.description }),
      ...(Object.keys(output).length === 0 ? {} : { output }),
    },
    { config: stringOption(opts, "config") },
  ).payload;
}
function localConfig(): FmcadConfiguration {
  // An explicit pure composition input, not configuration discovery. Local
  // execution never starts a session or touches credentials/the broker/Fusion.
  return {
    backend: "addin",
    routing: "queue",
    url: "http://127.0.0.1:8765/mcp",
    headers: {},
    timeoutMs: 180000,
    tool: "execute_python",
    transport: "node",
    protocolVersion: "2025-06-18",
    queue: { autoStart: false },
    controlCenter: { port: 4748 },
  };
}
function context(
  opts: CliOptions,
  payload?: CadWorkerInvocation,
): FmcadOptions["context"] {
  const cwd = process.cwd();
  const documentId = !payload
    ? undefined
    : payload.kind === "cad"
      ? (payload.docId ?? payload.docFileId ?? payload.doc)
      : payload.kind === "cad-command"
        ? (payload.invocation.docId ??
          payload.invocation.docFileId ??
          payload.invocation.doc)
        : (payload.request.identity.docId ??
          payload.request.identity.docFileId ??
          payload.request.doc);
  return {
    clientId:
      stringOption(opts, "client") ??
      process.env["FMCAD_CLIENT"] ??
      `cli:${os.hostname()}:${os.userInfo().username}`,
    instanceId: randomUUID(),
    projectId:
      "project:" + createHash("sha256").update(cwd).digest("hex").slice(0, 40),
    source: "cli",
    projectDirectory: cwd,
    ...(documentId ? { documentId } : {}),
    ...(opts.description ? { purpose: opts.description } : {}),
  };
}
export async function main(
  input: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const deps = { ...configuration, ...dependencies, stdout, stderr };
  const fail = (code: number): number => {
    if (code) {
      if (dependencies.setExitCode) dependencies.setExitCode(code);
      else process.exitCode = code;
    }
    return code;
  };
  const printHelp = (text: string) => {
    const format: {
      formatHelp(text: string, width: number): string;
    } = require("../../help-format");
    stdout.write(
      format.formatHelp(text, stdout.isTTY ? (stdout.columns ?? 80) : 80),
    );
  };
  let cfg: FmcadConfiguration | undefined;
  try {
    const parsed = invocation.parseInvocation(input);
    const argv = parsed.argv;
    const language: { locale(): string } = require("../../i18n");
    const local = async (
      command: LocalCommand,
      words: string[],
      helpWords: string[],
    ): Promise<number> => {
      if (argv.includes("--help") || argv.includes("-h")) {
        printHelp(help.detail(...helpWords));
        return 0;
      }
      return fail(await command(words, deps));
    };
    if (argv[0] === "fusion" && argv[1] === "reset") {
      return await local(
        async (words, ports) => {
          const reset: {
            fusionReset(
              words: string[],
              ports: CliDependencies,
            ): Promise<JsonValue>;
          } = require("../../fusion-reset");
          stdout.write(
            JSON.stringify(await reset.fusionReset(words, ports), null, 2) +
              "\n",
          );
          return 0;
        },
        argv.slice(2),
        ["fusion", "reset"],
      );
    }
    if (argv[0] === "console" || argv[0] === "diagnostic") {
      if (
        argv[0] === "diagnostic" &&
        !argv.includes("--help") &&
        !argv.includes("-h")
      )
        stderr.write(
          renderMessage("diagnosticAlias", {}, language.locale()) + "\n",
        );
      return await local(
        (require("../../console") as { consoleCommand: LocalCommand })
          .consoleCommand,
        argv.slice(1),
        ["console"],
      );
    }
    if (argv[0] === "queue" && argv[1])
      return await local(
        (require("../../queue-cli") as { queueCommand: LocalCommand })
          .queueCommand,
        argv.slice(1),
        argv.slice(0, 2),
      );
    const engineering: {
      methods: Record<string, unknown>;
      execute(
        key: string,
        args: string[],
        deps: CliDependencies,
      ): Promise<number>;
    } = require("../../engineering-local");
    const key = argv.slice(0, 2).join(" ");
    if (Object.hasOwn(engineering.methods, key))
      return await local(
        (words, ports) => engineering.execute(key, words, ports),
        argv.slice(2),
        argv.slice(0, 2),
      );
    const imageMethods = {
      trace: ["image-trace", "traceImage"],
      optimize: ["image-optimize", "optimizeImage"],
      boundaries: ["image-boundaries", "boundariesImage"],
    } as const;
    if (
      argv[0] === "image" &&
      argv[1] &&
      Object.hasOwn(imageMethods, argv[1])
    ) {
      const [module, method] =
        imageMethods[argv[1] as keyof typeof imageMethods];
      return await local(
        (require("../../" + module) as Record<string, LocalCommand>)[method]!,
        argv.slice(2),
        argv.slice(0, 2),
      );
    }
    const { opts, rest } = parseFlags(input);
    if (!rest.length) rest.push("help");
    const entry = commands.findCommand(rest);
    if (!entry)
      throw new CliError("unknownCommand", { command: rest[0] ?? "" });
    if (entry.kind === "help") {
      printHelp(
        rest[0] === "help" && rest[1] && !rest[1].startsWith("-")
          ? help.detail(...rest.slice(1))
          : help.globalHelp(),
      );
      return 0;
    }
    if (rest.includes("--help") || rest.includes("-h")) {
      printHelp(
        help.detail(
          ...rest.filter((word) => word !== "--help" && word !== "-h"),
        ),
      );
      return 0;
    }
    if (opts["routing"] === "direct") throw new CliError("direct");
    if (entry.kind === "family")
      throw new CliError("usage", { usage: entry.usage });
    if (entry.kind === "local")
      throw new CliError("localFlags", { command: entry.key });
    const execution = executionOptions(opts);
    // Read each original argument file once, retaining the hash of precisely
    // the bytes decoded by this adapter through the public admission boundary.
    const inputFiles: { path: string; sha256: string }[] = [];
    const readInput = (filename: string): Buffer => {
      const source = path.resolve(filename);
      const bytes = fs.readFileSync(source);
      inputFiles.push({
        path: source,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      return bytes;
    };
    let payload: CadWorkerInvocation | undefined;
    let localOnly = false;
    let cad: CadInput | undefined;
    let declaration: OperationDeclaration | undefined;
    if (entry.kind === "cad") {
      const operation = entry.target!;
      const spec = catalog.list().find((item) => item.operation === operation);
      if (!spec) throw new CliError("unknownCommand", { command: operation });
      declaration = spec.declaration;
      const spelling = [entry.key, ...(entry.aliases ?? [])]
        .sort((a, b) => b.length - a.length)
        .find(
          (word) => rest.slice(0, word.split(" ").length).join(" ") === word,
        )!;
      const parser: {
        parseCadInput(
          words: string[],
          inputs: unknown,
          formatting: unknown,
          readFile: typeof readInput,
        ): CadInput;
      } = require("../../cad-input");
      cad = parser.parseCadInput(
        rest.slice(spelling.split(" ").length),
        declaration.inputs,
        { ...declaration, observeShortcut: operation === "batch.reconcile" },
        readInput,
      );
      const { data, json, summary, ...pins } = cad;
      const value = catalogInput(operation, data, {
        ...pins,
        ...(opts.description ? { purpose: opts.description } : {}),
      });
      localOnly = catalog.isLocal(value);
      payload = {
        version: 1,
        kind: "cad-command",
        invocation: value,
        output: { json: json === true, summary: summary === true },
      };
    } else {
      const rawArgs = rest.slice(entry.key.split(" ").length);
      const { args, flags, listing } = parseCommand(entry, rawArgs);
      if (entry.kind === "init") {
        const result = (deps.initConfig ?? configuration.initConfig)({
          fromOpencode: !!flags["--from-opencode"],
          force: !!flags["--force"],
          config: opts["config"],
          ...(opts["backend"] ? { backend: opts["backend"] } : {}),
        });
        stdout.write(`WROTE ${result.path} (${result.note})\n`);
        return 0;
      }
      if (listing) {
        const run: {
          listScripts(options: {
            config?: string;
          }): { name: string; dir: string }[];
        } = require("../../run");
        const config = stringOption(opts, "config");
        for (const script of (deps.listScripts ?? run.listScripts)(
          config === undefined ? {} : { config },
        ))
          stdout.write(`${script.name} (${script.dir})\n`);
        return 0;
      }
      if (entry.kind === "call") JSON.parse(args[1]!);
      if (entry.kind === "review")
        (
          require("../../review") as {
            parseReviewArgs(words: string[]): unknown;
          }
        ).parseReviewArgs(rawArgs);
      if (entry.kind === "upload" || entry.kind === "export") {
        const platform: {
          detectPlatform(): unknown;
          toWindowsPath(value: string, facts: unknown): string;
        } = require("../../dist/config-platform");
        const windowsPath = (value: string) =>
          platform.toWindowsPath(path.resolve(value), platform.detectPlatform());
        if (entry.kind === "upload") windowsPath(args[0]!);
        else {
          const document = String(flags["--doc"]).replace(
            /[^A-Za-z0-9_.-]+/g,
            "_",
          );
          windowsPath(
            typeof flags["--out"] === "string"
              ? flags["--out"]
              : path.join(process.cwd(), document + "." + entry.target),
          );
        }
      }
      if (entry.kind === "run") {
        payload = runPayload(args[0]!, flags, opts, readInput);
        if (typeof flags["--out"] === "string")
          await (
            require("../../publish") as {
              checkPublishTarget(filename: string): Promise<void>;
            }
          ).checkPublishTarget(path.resolve(flags["--out"]));
        if (payload.kind === "run") {
          const run: {
            prepareRunScript(...args: unknown[]): unknown;
          } = require("../../run");
          const request = payload.request;
          // Shared local preparation validates injection/source before config or
          // admission. The worker re-prepares accepted, hash-bound bytes.
          run.prepareRunScript(
            request.name,
            request.args,
            request.hasArgs,
            request.doc ?? "",
            request.identity,
            request.helperVersion,
            request.readOnlyOperations,
          );
        }
      }
    }
    cfg = localOnly
      ? localConfig()
      : (deps.loadConfig ?? configuration.loadConfig)(opts).cfg;
    assertBrokerRouting(cfg);
    const runContext = context(opts, payload);
    return await invocation.context.run(
      {
        ...(opts.description ? { description: opts.description } : {}),
        label: entry.key,
      },
      async () => {
        if (!payload) {
          // Retained non-CAD families already have an application worker. This
          // compatibility path never constructs a physical client in this adapter.
          const queue: {
            runQueued: NonNullable<CliDependencies["runQueued"]>;
          } = require("../../queue-client");
          return fail(
            await (deps.runQueued ?? queue.runQueued)(input, cfg!, opts, deps),
          );
        }
        if (
          payload.kind === "run" &&
          payload.request.identity.readOnly === true &&
          cfg!.backend === "addin"
        )
          stderr.write(
            renderMessage("addinReadonly", {}, language.locale()) + "\n",
          );
        let previousState: string | undefined;
        let job: string | null = null;
        const receipt = await execute(
          payload,
          {
            config: cfg!,
            context: runContext,
            local: localOnly,
            execution: {
              ...execution,
              ...(inputFiles.length ? { inputFiles } : {}),
              ...(execution.queueTimeoutMs === undefined &&
              cfg!.queue?.waitTimeoutMs !== undefined
                ? { queueTimeoutMs: cfg!.queue.waitTimeoutMs }
                : {}),
            },
            ...(stringOption(opts, "request-id")
              ? { requestId: stringOption(opts, "request-id")! }
              : {}),
          },
          {
            ...deps,
            request: (requestId, clientId) =>
              stderr.write(
                "FMCAD_QUEUE_REQUEST " +
                  JSON.stringify({ requestId, clientId }) +
                  "\n",
              ),
            progress: (receipt) => {
              if (!receipt.jobId) return;
              if (!job) {
                job = receipt.jobId;
                stderr.write(
                  "FMCAD_QUEUE_JOB " +
                    JSON.stringify({
                      jobId: job,
                      requestId: receipt.requestId,
                    }) +
                    "\n",
                );
              }
              if (previousState !== receipt.state) {
                previousState = receipt.state;
                stderr.write(`QUEUE ${receipt.jobId} ${receipt.state}\n`);
              }
            },
          },
        );
        const result = receipt.result;
        if (receipt.output) {
          stdout.write(receipt.output.stdout);
          stderr.write(receipt.output.stderr);
        } else if (result !== null) {
          if (
            cad &&
            !cad.json &&
            (cad.summary || declaration?.["textSummary"])
          ) {
            stdout.write(
              (
                require("../../batch") as {
                  formatBatchSummary(value: JsonValue): string;
                }
              ).formatBatchSummary(result),
            );
          } else
            stdout.write(
              typeof result === "string"
                ? result + "\n"
                : JSON.stringify(result, null, cad?.json ? 0 : 2) + "\n",
            );
        } else if (receipt.jobId) stdout.write(JSON.stringify(receipt) + "\n");
        if (receipt.jobId)
          stderr.write(
            "FMCAD_QUEUE_RESULT " +
              JSON.stringify({
                id: receipt.jobId,
                requestId: receipt.requestId,
                state: receipt.state,
                outcome: receipt.outcome,
              }) +
              "\n",
          );
        const code = receiptExitCode(receipt);
        return fail(code);
      },
    );
  } catch (error) {
    const diagnostics: {
      redactDiagnostic(text: string, cfg?: FmcadConfiguration): string;
      formatJsonError(error: SyntaxError): string;
    } = require("../../diagnostics");
    const language: { locale(): string } = require("../../i18n");
    const message =
      error instanceof CliError
        ? renderMessage(
            error.messageId,
            error.argumentsValue,
            language.locale(),
          )
        : error instanceof Error &&
            error.message.includes('routing=direct is no longer supported')
          ? renderMessage("direct", {}, language.locale())
          : error instanceof SyntaxError &&
              /^\s+at JSON\.parse \(/m.test(error.stack ?? "")
            ? diagnostics.formatJsonError(error)
            : error instanceof Error
              ? error.message
              : String(error);
    const unknownHelp =
      error instanceof CliError && error.messageId === "unknownCommand"
        ? "\n\n" + help.globalHelp()
        : "";
    stderr.write(
      diagnostics.redactDiagnostic(
        "ERROR " + message + unknownHelp + "\n",
        cfg,
      ),
    );
    return fail(1);
  }
}
