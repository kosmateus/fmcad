// Run the installed package's unchanged regression tests against this isolated
// runtime. No installed executable or active broker is edited or contacted.
import Module, { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
type ResolveFilename = (
  request: string,
  parent?: NodeModule,
  isMain?: boolean,
  options?: { paths?: string[] },
) => string;
const resolver = Module as unknown as { _resolveFilename: ResolveFilename };
const load = createRequire(path.resolve(__dirname, "../../package.json"));
const installed =
  process.env["FMCAD_UPSTREAM_TEST_ROOT"] || path.resolve(__dirname, "../..");
const staged = path.resolve(__dirname, "../..");
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (...args: Parameters<ResolveFilename>) {
  const file = resolve.apply(this, args);
  if (
    typeof file === "string" &&
    (file.startsWith(installed + "/src/") ||
      file.startsWith(installed + "/assets/"))
  )
    return staged + file.slice(installed.length);
  return file;
};
for (const file of [
  "queue-scheduling.test.js",
  "queue-probe-recovery.test.js",
  "queue-document.test.js",
  "addin-bridge.test.js",
  "document-identity.test.js",
  "run-identity.test.js",
  "run-out.test.js",
  "review.test.js",
  "console-pause.test.js",
  "mcp-stdio.test.js",
  "backend-cli.test.js",
  "execution-budget.test.js",
]) {
  const retained = path.join(installed, "tests", file);
  const compiled = path.join(installed, "dist/tests", file);
  // A migrated suite retains the same assertion body under its compiled path.
  load(fs.existsSync(retained) ? retained : compiled);
}
