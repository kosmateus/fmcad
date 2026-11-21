import { createRequire } from "node:module";
const load = createRequire(__filename);
const { refreshConsoleDetail } = load(
  "../core",
) as typeof import("@fmcad/core");
export const {
  kindOf,
  correlate,
  describeConsoleRow: describe,
} = load("../core") as typeof import("@fmcad/core");
export function refresh(
  modal: Parameters<typeof refreshConsoleDetail>[0],
  model: Parameters<typeof refreshConsoleDetail>[1],
): void {
  refreshConsoleDetail(modal, model, structuredClone);
}
