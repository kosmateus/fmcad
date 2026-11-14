import path from "node:path";
import { createRequire } from "node:module";
import type { FmcadConfiguration } from "@fmcad/core";
const load = createRequire(__filename);
export interface LegacyRequest {
  payload: {
    entry: {
      kind: string;
      target: string;
      targetArg?: string;
      pathMapper?: boolean;
      requiresDoc?: boolean;
      readOnly?: boolean;
    };
    flags: Readonly<Record<string, string | boolean | undefined>>;
    listing?: boolean;
    rawArgs: readonly string[];
    args: readonly string[];
    options: { config?: string };
  };
}
export interface LegacyBackend {
  server: FmcadConfiguration;
  capabilities?: unknown;
  serverInfo?: { name?: unknown; version?: unknown };
  negotiatedProtocolVersion?: unknown;
  listTools(): Promise<readonly { name: string }[]>;
  callTool(
    args: unknown,
    tool?: string,
  ): Promise<{
    data?: unknown;
    text: string;
    stderr?: string;
    failed?: boolean;
  }>;
}
function argument(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Queued command argument is missing");
  return value;
}
// Existing non-CAD command adapters consume the broker's parsed DTO. This is
// formatting/composition, not another argv parser or a physical SDK transport.
export async function execute(
  request: LegacyRequest,
  client: LegacyBackend,
  onOutcome: (outcome: unknown) => void,
): Promise<number> {
  const { entry, flags, listing, rawArgs, options: opts } = request.payload;
  const args = [...request.payload.args];
  const cfg = client.server;
  const { redactDiagnostic } = load("../core") as typeof import("@fmcad/core");
  const print = (text: string) => process.stdout.write(text);
  const windowsPath = (value: string) => {
    if (/^[A-Za-z]:[\\/]|^\\\\/.test(value)) return value;
    const platform = load("../config-platform") as {
      detectPlatform(): unknown;
      toWindowsPath(value: string, platform: unknown): string;
    };
    return platform.toWindowsPath(
      path.resolve(value),
      platform.detectPlatform(),
    );
  };
  if (listing) {
    for (const script of (
      load("../../run") as {
        listScripts(options: {
          config?: string | undefined;
        }): readonly { name: string; dir: string }[];
      }
    ).listScripts({ config: opts.config }))
      print(`${script.name} (${script.dir})\n`);
    return 0;
  }
  if (entry.kind === "help") {
    print((load("../../help") as { globalHelp(): string }).globalHelp());
    return 0;
  }
  if (entry.kind === "tools" || entry.kind === "doctor") {
    if (entry.kind === "doctor") {
      print(
        `CONFIG url=${new URL(cfg.url).origin}/[endpoint-redacted] tool=${cfg.tool} timeoutMs=${cfg.timeoutMs}\n`,
      );
      print(
        `BACKEND name=${cfg.backend || "mcp"} transport=${cfg.transport || "node"}\n`,
      );
      if (client.capabilities)
        print("CAPABILITIES " + JSON.stringify(client.capabilities) + "\n");
    }
    const tools = await client.listTools();
    if (entry.kind === "tools") {
      if (flags["--json"]) print(JSON.stringify(tools, null, 2) + "\n");
      else for (const tool of tools) print(tool.name + "\n");
    } else {
      const reported = (value: unknown) =>
        typeof value === "string" && value.trim()
          ? redactDiagnostic(value, cfg)
          : "not reported";
      print(
        "SERVER " +
          JSON.stringify({
            name: reported(client.serverInfo?.name),
            version: reported(client.serverInfo?.version),
            protocolVersion: reported(client.negotiatedProtocolVersion),
          }) +
          "\n",
      );
      print(
        `MCP_OK tools=${tools.length} (${tools.map((tool) => tool.name).join(", ")})\n`,
      );
    }
    return 0;
  }
  if (entry.kind === "docops") {
    const commands = load("../../docops") as Record<
      string,
      (
        backend: LegacyBackend,
        args: string | readonly string[],
        map?: (value: string) => string,
      ) => Promise<number>
    >;
    const command = commands[entry.target];
    if (!command)
      throw new Error("Unsupported document command: " + entry.target);
    return command(
      client,
      entry.targetArg || rawArgs,
      entry.pathMapper ? windowsPath : undefined,
    );
  }
  if (entry.kind === "review") {
    const review = load("../../review") as {
      parseReviewArgs(args: readonly string[]): unknown;
      reviewCmd(
        client: LegacyBackend,
        args: readonly string[],
        map: (value: string) => string,
        io: { stdout: NodeJS.WriteStream },
      ): Promise<number>;
    };
    review.parseReviewArgs(rawArgs);
    return review.reviewCmd(client, rawArgs, windowsPath, {
      stdout: process.stdout,
    });
  }
  let script: string | undefined;
  let callArgs: unknown;
  const operations = load("../../ops") as {
    buildOpScript(
      target: string,
      args: readonly (string | boolean | undefined)[],
    ): string;
    buildExportScript(args: readonly (string | boolean | undefined)[]): string;
  };
  switch (entry.kind) {
    case "call":
      callArgs = JSON.parse(argument(args[1]));
      break;
    case "op":
      if (entry.target === "param_add") while (args.length < 4) args.push("");
      script = operations.buildOpScript(
        entry.target,
        entry.requiresDoc ? [...args, flags["--doc"]] : args,
      );
      break;
    case "upload":
      script = operations.buildOpScript(entry.target, [
        windowsPath(argument(args[0])),
        flags["--project"] || "",
        flags["--folder"] || "",
      ]);
      break;
    case "export": {
      const name = String(flags["--doc"]).replace(/[^A-Za-z0-9_.-]+/g, "_");
      script = operations.buildExportScript([
        entry.target,
        flags["--body"] || "",
        windowsPath(
          (typeof flags["--out"] === "string" ? flags["--out"] : "") ||
            path.join(process.cwd(), name + "." + entry.target),
        ),
        flags["--doc"],
      ]);
      break;
    }
    default:
      throw new Error(`Unsupported queued command service: ${entry.kind}`);
  }
  if (flags["--readonly"] && cfg.backend === "addin")
    process.stderr.write(
      "WARNING: addin does not enforce a read-only sandbox; --readonly is a declaration only.\n",
    );
  const out =
    entry.kind === "call"
      ? await client.callTool(callArgs, args[0])
      : await client.callTool({
          featureType: "script",
          object: {
            script,
            ...(entry.readOnly || flags["--readonly"]
              ? { readOnly: true }
              : {}),
          },
        });
  if (out.data) onOutcome(out.data);
  print(out.text + "\n");
  if (out.stderr && !out.failed)
    process.stderr.write(redactDiagnostic(out.stderr, cfg));
  return out.failed ? 1 : 0;
}
