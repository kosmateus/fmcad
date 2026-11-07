import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const runtimeRequire = createRequire(__filename);
const scripts = runtimeRequire(
  "../python/run-script.js",
) as typeof import("../../packages/node-adapters/src/python/run-script.js");

interface SourceProvenance {
  sourcePath?: string;
  sourceHash?: string;
}

type RunScripts = ReturnType<typeof scripts.createRunScriptAdapter>;

const adapter: RunScripts = scripts.createRunScriptAdapter({
  observeSource(filename, bytes) {
    const invocation = runtimeRequire("../../invocation.js") as {
      context: { getStore(): SourceProvenance | undefined };
    };
    const current = invocation.context.getStore();
    if (current) {
      current.sourcePath = filename;
      current.sourceHash = createHash("sha256").update(bytes).digest("hex");
    }
  },
  verifySource(filename, bytes) {
    if (!process.env["FMCAD_QUEUE_WORKER_JOB"]) return;
    const queue = runtimeRequire("../../queue-client.js") as {
      verifyInputBytes(filename: string, bytes: Buffer): void;
    };
    queue.verifyInputBytes(filename, bytes);
  },
});

export const prepareRunScript: RunScripts["prepareRunScript"] =
  adapter.prepareRunScript;
export const buildRunScript: RunScripts["buildRunScript"] =
  adapter.buildRunScript;
export const resolveScript: RunScripts["resolveScript"] = adapter.resolveScript;
export const userScriptsDir: RunScripts["userScriptsDir"] =
  adapter.userScriptsDir;
export const pkgScriptsDir: RunScripts["pkgScriptsDir"] = adapter.pkgScriptsDir;
export const listScripts: RunScripts["listScripts"] = adapter.listScripts;
export const { validateRunIdentity, validateRunOutput, formatRunOutput } =
  scripts;
