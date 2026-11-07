import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

async function main(): Promise<void> {
  const persistent = process.argv[2] === "true";
  const root = path.resolve(__dirname, "../../..");
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "checker-cleanup-"),
  );
  const original = fs.rmdir;
  let failures = 0;
  fs.rmdir = ((
    directory: fs.PathLike,
    options: fs.RmDirOptions | fs.NoParamCallback,
    callback?: fs.NoParamCallback,
  ) => {
    const done = typeof options === "function" ? options : callback;
    if (!done) throw new Error("Missing rmdir callback");
    const name = String(directory);
    if (
      name.startsWith(temporaryRoot + path.sep) &&
      path.basename(name) === "analysis" &&
      (persistent || failures === 0)
    ) {
      failures++;
      const error = Object.assign(
        new Error("injected directory visibility failure"),
        { code: "ENOTEMPTY" },
      );
      queueMicrotask(() => done(error));
    } else if (typeof options === "function") original(directory, options);
    else original(directory, options, done);
  }) as typeof fs.rmdir;
  try {
    const load = createRequire(path.join(root, "package.json"));
    const { createPythonChecker } = load(
      "./packages/node-adapters/dist/python/checker",
    ) as typeof import("../../packages/node-adapters/src/python/checker");
    const { preparePythonArtifact } = load(
      "./src/python",
    ) as typeof import("../../packages/node-adapters/src/python/artifact");
    const typingRoot = path.join(root, "dist/runtime/python/typing");
    const checker = createPythonChecker({
      typingRoot,
      definitionsRoot: typingRoot,
      temporaryRoot,
      pythonPlatform: "Windows",
    });
    const artifact = preparePythonArtifact([
      {
        id: "cleanup",
        filename: "cleanup.py",
        role: "wrapper",
        source: "def run(context: str) -> None:\n    print(context)\n",
      },
    ]);
    let status: string;
    try {
      status = (await checker.check({ artifact, context: { kind: "bundle" } }))
        .status;
    } catch (error: unknown) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOTEMPTY"
      )
        throw error;
      status = error.code;
    }
    console.log(
      JSON.stringify({
        status,
        failures,
        remaining: fs.readdirSync(temporaryRoot),
      }),
    );
  } finally {
    fs.rmdir = original;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
