import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import type { Plugin as V2 } from "@opencode/plugin";

/** Host loaders select their own entrypoint. Never probe setup or fall back after effects. */
const plugin = {
  id: "fmcad",
  // Keep the loader-facing declaration host-neutral so importing the package's
  // types never requires the inactive SDK. Each selected adapter checks its host.
  async server(
    input: unknown,
    options?: Record<string, unknown>,
  ): Promise<unknown> {
    const [{ createV1 }, { dependencies }] = await Promise.all([
      import("../../packages/opencode-adapter/src/v1/index.js"),
      import("../composition/opencode.js"),
    ]);
    return createV1(dependencies())(input as Parameters<V1Plugin>[0], options);
  },
  async setup(ctx: unknown): Promise<(() => void | Promise<void>) | void> {
    const [{ createV2 }, { dependencies }] = await Promise.all([
      import("../../packages/opencode-adapter/src/v2/index.js"),
      import("../composition/opencode.js"),
    ]);
    return createV2(dependencies()).setup(
      ctx as Parameters<V2.Plugin["setup"]>[0],
    );
  },
};
export default plugin;
