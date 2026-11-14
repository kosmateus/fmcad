import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";
const root = process.cwd();
interface Entry {
  sourcePath: string;
  file: string;
  sha256: string;
}
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(root, "tests/fixtures/history/manifest.json"),
    "utf8",
  ),
) as Entry[];
function historical(name: string): string {
  const entry = manifest.find(
    (row) => row.sourcePath === "src/" + name + ".js",
  );
  assert.ok(entry);
  const bytes = fs.readFileSync(
    path.join(root, "tests/fixtures/history", entry.file),
  );
  assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  return bytes.toString("utf8");
}
async function run(source: string, name: string, failure: boolean | "claim") {
  const audit = "/private/audit",
    nonce = "owned",
    marker = { pid: 17, birth: "boot:tick", nonce };
  const input = {
    cfg: { backend: "synthetic" },
    dir: "/private/queue",
    audit,
    nonce,
  };
  const intent = {
    nonce,
    approval: {
      buildHash: "build",
      requestId: "request",
      stateOptions: { idleMs: 60000 },
    },
  };
  const writes: unknown[] = [],
    events: unknown[] = [],
    diagnostics: string[] = [];
  const processPort = {
    argv: ["node", name, audit],
    pid: 17,
    exitCode: 0,
    stdin: {
      async *[Symbol.asyncIterator]() {
        yield JSON.stringify(input);
      },
    },
    stderr: {
      write(value: string) {
        diagnostics.push(value);
      },
    },
    on(signal: string) {
      events.push(signal);
    },
    once(signal: string) {
      events.push(signal);
    },
  };
  const api = {
    buildHash: () => "build",
    hash: () => "audit",
    processBirth: () => "boot:tick",
    priorProcessAlive: () => true,
    readJson: (file: string) =>
      file.endsWith("intent.json") ? intent : marker,
    durable: (file: string, value: unknown, exclusive: boolean) => {
      if (failure === "claim" && /worker(?:-claim)?\.json$/.test(file))
        throw Object.assign(new Error("Already claimed"), { code: "EEXIST" });
      writes.push({ file, value, exclusive });
    },
  };
  const host = {
    async serve(cfg: unknown, options: unknown) {
      events.push({ cfg, options });
      if (failure === true)
        throw Object.assign(new Error("synthetic startup rejection"), {
          code: "SYNTHETIC_FAILURE",
        });
      return { dir: "/private/queue", buildHash: "build", async close() {} };
    },
  };
  const modulePort = { exports: {} };
  const requirePort = Object.assign(
    (id: string): unknown => {
      if (id === "node:path") return path;
      if (id === "node:fs")
        return {
          readFileSync: () => JSON.stringify(input),
          realpathSync: (file: string) => file,
        };
      if (id === "node:module") return { createRequire: () => requirePort };
      if (id === "./queue-instance") return api;
      if (id === "./queue-broker") return host;
      if (id === "./queue-atomic-migration-files")
        return {
          exclusive: (file: string, value: unknown) =>
            api.durable(file, value, true),
        };
      throw new Error("Unexpected worker dependency " + id);
    },
    { main: modulePort },
  );
  vm.runInNewContext(source, {
    require: requirePort,
    module: modulePort,
    exports: modulePort.exports,
    __filename: "/private/" + name + ".js",
    process: processPort,
    Buffer,
    console: {
      error(error: unknown) {
        diagnostics.push(
          error instanceof Error ? error.message : String(error),
        );
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return JSON.parse(
    JSON.stringify({
      writes,
      events,
      diagnostics,
      exitCode: processPort.exitCode,
    }),
  ) as unknown;
}
for (const name of [
  "queue-atomic-migration-worker",
  "queue-epoch-runtime-worker",
  "queue-epoch-successor-worker",
]) {
  for (const failure of [false, true, "claim"] as const)
    test(
      name +
        " preserves claim/start/publication choreography: " +
        (failure === "claim" ? "lost-claim" : failure ? "failure" : "success"),
      async () => {
        const typed = ts.transpileModule(
          fs.readFileSync(path.join(root, "src", name + ".ts"), "utf8"),
          {
            compilerOptions: {
              module: ts.ModuleKind.CommonJS,
              target: ts.ScriptTarget.ES2023,
              esModuleInterop: true,
            },
          },
        ).outputText;
        assert.deepEqual(
          await run(typed, name, failure),
          await run(historical(name), name, failure),
        );
      },
    );
}
