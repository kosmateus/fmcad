/** @deprecated Use the built root fmcad dual plugin. V1 remains supported. */
import type { Plugin } from "@opencode-ai/plugin";
const legacyFmcad: Plugin = async (...args) => {
  const { default: plugin } = await import("../dist/entrypoints/opencode.mjs");
  return (await plugin.server(...args)) as Awaited<ReturnType<Plugin>>;
};
export default legacyFmcad;
