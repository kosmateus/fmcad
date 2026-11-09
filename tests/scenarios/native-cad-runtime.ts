import { createRequire } from "node:module";
import path from "node:path";

const load = createRequire(path.join(process.cwd(), "package.json"));
const { buildCadScript } = load(
  "./src/cad.js",
) as typeof import("../../src/composition/cad");

/** Use the production camera handlers retained by the historical style/save probe. */
export function nativeCadRuntime(): string {
  const source = buildCadScript(
    "document.status",
    {},
    {
      doc: "FMCAD_ORIGINAL_USER_VIEW",
      component: "root",
    },
  );
  const marker = "\n_FMCAD_REQUEST: ";
  const offset = source.indexOf(marker);
  if (offset < 0)
    throw new Error("Production CAD request boundary is unavailable");
  return source.slice(0, offset);
}
