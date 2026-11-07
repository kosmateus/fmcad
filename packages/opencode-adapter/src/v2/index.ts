import type { Plugin } from "@opencode/plugin";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import type { Dependencies, Invocation } from "../shared/contracts";
import { requestWebEnsure } from "../shared/ensure-web.js";
import {
  createTools,
  helpSchema,
  executeSchema,
  AdapterError,
  wait,
} from "../shared/tools";

/** Recommended host. SDK types erase completely; no inactive SDK runtime import. */
export function createV2(deps: Dependencies): Plugin.Plugin {
  return {
    id: "fmcad",
    async setup(ctx) {
      const version = /^2\.(\d+)\.(\d+)(?:\+.*)?$/.exec(
        ctx?.app?.version ?? "",
      );
      if (
        !version ||
        Number(version[1]) < 1 ||
        (Number(version[1]) === 1 && Number(version[2]) < 3) ||
        !ctx.tool?.transform ||
        !ctx.session?.get ||
        !ctx.permission?.assert ||
        !ctx.event?.subscribe
      )
        throw new AdapterError(
          "FMCAD_UNSUPPORTED_HOST",
          "Expected OpenCode >=2.1.3 <3 plugin contract",
        );
      const tools = createTools(deps, ctx.options);
      const controller = new AbortController();
      const presence = deps.presence(ctx.location.directory);
      const events = (async () => {
        try {
          for await (const event of ctx.event.subscribe({
            signal: controller.signal,
          }))
            presence?.event({ type: event.type, properties: event.data });
        } catch {
          /* Passive diagnostics must not fail execution. */
        }
      })();
      async function invocation(tool: ToolContext): Promise<Invocation> {
        tool.signal.throwIfAborted();
        const session = await wait(
          ctx.session.get(
            { sessionID: tool.sessionID },
            { signal: tool.signal },
          ),
          tool.signal,
        );
        const directory = session.location.directory;
        if (!directory)
          throw new AdapterError(
            "FMCAD_SESSION_LOCATION",
            "Calling session has no directory",
          );
        presence?.touch(tool.sessionID, {
          agent: tool.agent,
          project: directory,
        });
        return {
          ...(session.projectID ? { projectId: session.projectID } : {}),
          sessionID: tool.sessionID,
          agent: tool.agent,
          directory,
          signal: tool.signal,
          async authorize(resource, metadata) {
            const input = {
              sessionID: tool.sessionID,
              agent: tool.agent,
              source: {
                type: "tool" as const,
                messageID: tool.messageID,
                id: tool.id,
              },
              resources: [resource],
              metadata,
            };
            await ctx.permission.assert({ ...input, action: "fmcad_execute" });
            tool.signal.throwIfAborted();
            await ctx.permission.assert({ ...input, action: "shell" });
          },
        };
      }
      try {
        const registration = await ctx.tool.transform((editor) => {
          editor.add({
            name: "fmcad_help",
            description:
              "Offline fmcad public operation catalog. No Fusion connection.",
            input: helpSchema,
            async execute(input, tool) {
              return {
                content: await tools.help(input, await invocation(tool)),
              };
            },
          });
          editor.add({
            name: "fmcad_execute",
            description:
              "Typed fmcad API: execute, query receipts or control an existing job. Never replays unknown work.",
            input: executeSchema,
            async execute(input, tool) {
              return {
                content: await tools.execute(input, await invocation(tool)),
              };
            },
          });
        });
        requestWebEnsure(deps);
        let disposed = false;
        return async () => {
          if (disposed) return;
          disposed = true;
          controller.abort();
          await registration.dispose();
          await events;
          await presence?.close();
          await tools.dispose();
        };
      } catch (error) {
        controller.abort();
        await events;
        await presence?.close();
        await tools.dispose();
        throw error;
      }
    },
  };
}
