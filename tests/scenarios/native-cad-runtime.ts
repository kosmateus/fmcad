import { createRequire } from "node:module";
import path from "node:path";

const load = createRequire(path.join(process.cwd(), "package.json"));
const { prepareCadScript } = load(
  "./src/cad",
) as typeof import("../../src/composition/cad");
const { selectRunBundle } = load(
  "./packages/node-adapters/dist/python/source-selection",
) as typeof import("../../packages/node-adapters/src/python/source-selection");

/** Use the production camera handlers retained by the historical style/save probe. */
export function nativeCadRuntime(operations?: readonly string[]): string {
  // Keep the production runtime units, not the request-specific TypedDict and
  // wrapper. The document.status profile also omits camera handlers. These
  // probes call CadContext directly. Select declared operations while retaining
  // the existing default profile for callers outside the original-view scope.
  const units = operations
    ? selectRunBundle(
        process.cwd(),
        "def run(context: str):\n" +
          operations
            .map(
              (operation) => `    FMCAD.call(${JSON.stringify(operation)}, {})`,
            )
            .join("\n"),
        true,
      )
    : prepareCadScript(
        "document.status",
        {},
        {
          doc: "FMCAD_ORIGINAL_USER_VIEW",
          component: "root",
        },
      ).units.filter((unit) => unit.role === "runtime");
  if (units.length === 0)
    throw new Error("Production CAD runtime units are unavailable");
  return units.map((unit) => unit.source).join("\n\n");
}
