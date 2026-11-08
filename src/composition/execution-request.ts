import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  OperationDeclaration,
  WorkerRequest,
  ParsedCadWorkerCommand,
} from "@fmcad/core";
import type { CommandEntry, CommandFlags } from "../entrypoints/cli/parser.js";

const load = createRequire(__filename);

export interface AcceptedCommandRequest extends WorkerRequest {
  description?: string | undefined;
}

// The existing parser validates these value flags against the run command table.
type RunFlags = CommandFlags &
  Partial<
    Record<
      | "--args-file"
      | "--args"
      | "--doc"
      | "--doc-id"
      | "--doc-file-id"
      | "--helpers"
      | "--out"
      | "--out-format"
      | "--pretty",
      string
    >
  >;

/** Project the worker envelope without changing the broker's accepted request. */
export function prepareRequest<T extends AcceptedCommandRequest>(job: {
  request: T;
}) {
  const request = job.request;
  if (request.payload && request.payload["kind"] !== "legacy-command")
    return request;
  const parser = load(
    "../entrypoints/cli/parser.js",
  ) as typeof import("../entrypoints/cli/parser.js");
  const commands = load("../../commands.js") as {
    findCommand(argv: string[]): CommandEntry | undefined;
  };
  const catalog = load("../../catalog/index.js") as {
    catalog: Record<string, OperationDeclaration>;
  };
  const inputPlanning = load(
    "../core/application/cad/input.js",
  ) as typeof import("../../packages/core/src/application/cad/input.js");
  const commandService = load(
    "./cad-service.js",
  ) as typeof import("./cad-service.js");
  const instance = load("../../queue-instance.js") as {
    hash(bytes: Buffer): string;
  };

  const argv = [...request.argv];
  for (let i = 0; i < argv.length; i++) {
    if (["--file", "--args-file", "--config"].includes(argv[i]!) && argv[i + 1])
      argv[++i] = path.resolve(request.cwd, argv[i]!);
  }
  const { opts, rest } = parser.parseFlags(argv);
  const entry = commands.findCommand(rest);
  if (!entry) throw new Error(`unknown command: ${rest[0]}`);
  const purpose = request.description || opts.description;
  if (entry.kind === "cad") {
    const spec = catalog.catalog[entry.target!]!;
    const spelling = [entry.key, ...(entry.aliases || [])]
      .sort((a, b) => b.length - a.length)
      .find(
        (value) => rest.slice(0, value.split(" ").length).join(" ") === value,
      )!;
    const plan = inputPlanning.planCadInput(
      rest.slice(spelling.split(" ").length),
      spec.inputs,
      { ...spec, observeShortcut: entry.target === "batch.reconcile" },
    );
    let fileText: string | undefined;
    if (plan.payload?.kind === "file") {
      const bytes = fs.readFileSync(plan.payload.value);
      const pinned = request.inputFiles?.find(
        (input) =>
          path.resolve(request.cwd, input.path) === plan.payload!.value,
      );
      if (pinned && instance.hash(bytes) !== pinned.sha256)
        throw Object.assign(new Error("Accepted CAD input bytes changed"), {
          code: "INPUT_CHANGED",
        });
      fileText = bytes.toString("utf8");
    }
    const input = inputPlanning.decodeCadInput(plan, fileText);
    // Retain explicit undefined option keys from the legacy envelope. The
    // command service still applies its production decoder before returning.
    const typed = commandService.fromParsedCommand({
      kind: "cad",
      operation: entry.target!,
      data: input.data,
      context: {
        doc: input.doc,
        docId: input.docId,
        docFileId: input.docFileId,
        component: input.component,
        projectId: input.projectId,
        preview: input.preview,
      },
      json: input.json,
      summary: input.summary,
      purpose,
    } as ParsedCadWorkerCommand);
    return { ...request, ...typed };
  }
  const rawArgs = rest.slice(entry.key.split(" ").length);
  const { args, flags, listing } = parser.parseCommand(entry, rawArgs);
  if (entry.kind === "run" && !listing) {
    const values = flags as RunFlags;
    const argumentFile =
      values["--args-file"] === undefined
        ? undefined
        : path.resolve(request.cwd, values["--args-file"]);
    const bytes =
      argumentFile === undefined ? undefined : fs.readFileSync(argumentFile);
    if (bytes) {
      const pinned = request.inputFiles?.find(
        (input) => path.resolve(request.cwd, input.path) === argumentFile,
      );
      if (pinned && instance.hash(bytes) !== pinned.sha256)
        throw Object.assign(new Error("Accepted run argument bytes changed"), {
          code: "INPUT_CHANGED",
        });
    }
    const payload =
      bytes === undefined ? values["--args"] : bytes.toString("utf8");
    const source = path.isAbsolute(args[0]!)
      ? args[0]!
      : path.resolve(request.cwd, args[0]!);
    // Retain explicit undefined option keys from the legacy envelope. The
    // command service still applies its production decoder before returning.
    const typed = commandService.fromParsedCommand(
      {
        kind: "run",
        purpose,
        request: {
          name: fs.existsSync(source) ? source : args[0]!,
          args: payload === undefined ? [] : (JSON.parse(payload) as unknown),
          hasArgs: payload !== undefined,
          doc: values["--doc"] || "",
          identity: {
            docId: values["--doc-id"],
            docFileId: values["--doc-file-id"],
            readOnly: !!flags["--readonly"],
          },
          helperVersion: values["--helpers"],
        },
        ...(values["--out"] === undefined
          ? {}
          : {
              output: {
                path: path.resolve(request.cwd, values["--out"]),
                ...(values["--out-format"] === undefined
                  ? {}
                  : { format: values["--out-format"] }),
                ...(values["--pretty"] === undefined
                  ? {}
                  : { pretty: values["--pretty"] === "true" }),
              },
            }),
      } as ParsedCadWorkerCommand,
      typeof opts["config"] === "string" ? { config: opts["config"] } : {},
    );
    return { ...request, ...typed };
  }
  return {
    ...request,
    payload: {
      version: 1,
      kind: "legacy-command",
      entry,
      args,
      flags,
      listing,
      rawArgs,
      options: opts,
      purpose,
    },
  };
}
