import type { Plugin, ToolContext } from "@opencode-ai/plugin";
import type { Dependencies, Invocation } from "../shared/contracts";
import { createTools, AdapterError } from "../shared/tools";
import { requestWebEnsure } from "../shared/ensure-web.js";

/** Deprecated, still supported and tested; the V1 object loader requires >=1.18.29. */
export function createV1(deps: Dependencies): Plugin {
  return async (host, options = {}) => {
    if (!host?.client?.session?.get || typeof host.directory !== "string")
      throw new AdapterError(
        "FMCAD_UNSUPPORTED_HOST",
        "Expected OpenCode V1 >=1.18.29 object loader",
      );
    const { tool } = await import("@opencode-ai/plugin");
    const tools = createTools(deps, options);
    const presence = deps.presence(host.directory);
    function invocation(ctx: ToolContext): Invocation {
      const directory = ctx.directory || ctx.worktree;
      if (!directory)
        throw new AdapterError(
          "FMCAD_SESSION_LOCATION",
          "Calling session has no directory",
        );
      presence?.touch(ctx.sessionID, { agent: ctx.agent, project: directory });
      return {
        ...(host.project?.id ? { projectId: host.project.id } : {}),
        sessionID: ctx.sessionID,
        agent: ctx.agent,
        directory,
        signal: ctx.abort,
        async authorize(resource, metadata) {
          await ctx.ask({
            permission: "fmcad_execute",
            patterns: [resource],
            always: [],
            metadata,
          });
          ctx.abort.throwIfAborted();
          await ctx.ask({
            permission: "bash",
            patterns: [resource],
            always: [],
            metadata,
          });
        },
      };
    }
    let disposed = false;
    const hooks: Awaited<ReturnType<Plugin>> = {
      tool: {
        fmcad_help: tool({
          description:
            "Offline fmcad public operation catalog. No Fusion connection.",
          args: { operation: tool.schema.string().optional() },
          execute: (input, ctx) => tools.help(input, invocation(ctx)),
        }),
        fmcad_execute: tool({
          description:
            "Typed fmcad API: execute, query receipts or control an existing job. Never replays unknown work.",
          args: {
            action: tool.schema
              .enum([
                "execute",
                "result",
                "request",
                "status",
                "cancel",
                "reconcile",
              ])
              .optional(),
            invocation: tool.schema
              .record(tool.schema.string(), tool.schema.unknown())
              .optional(),
            requestId: tool.schema.string().min(1).max(256).optional(),
            jobId: tool.schema.string().min(1).max(256).optional(),
            sequence: tool.schema
              .object({
                action: tool.schema.enum(["begin", "continue", "end"]),
                id: tool.schema.string().optional(),
                mode: tool.schema.enum(["automatic", "exclusive"]).optional(),
              })
              .strict()
              .optional(),
            expectedRevision: tool.schema
              .number()
              .int()
              .min(0)
              .max(2147483647)
              .optional(),
            queueTimeoutMs: tool.schema
              .number()
              .int()
              .min(1)
              .max(2147483647)
              .optional(),
          },
          execute: (input, ctx) => tools.execute(input, invocation(ctx)),
        }),
      },
      event: async ({ event }) => {
        presence?.event(event);
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        await presence?.close();
        await tools.dispose();
      },
    };
    requestWebEnsure(deps);
    return hooks;
  };
}
