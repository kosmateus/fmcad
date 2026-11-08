import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import * as http from "node:http";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { createPythonChecker } from "../../packages/node-adapters/src/python/checker";
import type { preparePythonArtifact } from "../../packages/node-adapters/src/python/artifact";
import type {
  pythonUnitContexts,
  pythonArtifactManifest,
  retainPythonOrigin,
} from "../../packages/node-adapters/src/python/context-binding";
import type {
  Execution,
  Owner,
  Protocol,
  ScenarioBackend,
  ScriptRequest,
} from "./contracts";
import { record, text } from "./contracts";
import { componentCommand } from "./component-command";

interface PythonResult {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string;
}
interface PythonTools {
  createPythonChecker: typeof createPythonChecker;
  preparePythonArtifact: typeof preparePythonArtifact;
  pythonUnitContexts: typeof pythonUnitContexts;
  pythonArtifactManifest: typeof pythonArtifactManifest;
  retainPythonOrigin: typeof retainPythonOrigin;
}
export class PythonSimulator {
  readonly instanceId = randomUUID();
  readonly child: ChildProcessWithoutNullStreams;
  readonly #pending: {
    resolve(value: PythonResult): void;
    reject(error: Error): void;
  }[] = [];
  #closed = false;
  #diagnostics = "";
  executions = 0;
  constructor(root: string) {
    this.child = spawn(
      "python3",
      ["-B", path.join(root, "tests/support/fusion-simulator/server.py")],
      { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
    );
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      const pending = this.#pending.shift();
      if (!pending) {
        this.child.kill();
        return;
      }
      try {
        const value = record(JSON.parse(line) as unknown);
        if (
          typeof value["success"] !== "boolean" ||
          typeof value["stdout"] !== "string" ||
          typeof value["stderr"] !== "string" ||
          typeof value["error"] !== "string"
        )
          throw new Error("Malformed simulator response");
        pending.resolve({
          success: value["success"],
          stdout: value["stdout"],
          stderr: value["stderr"],
          error: value["error"],
        });
      } catch (error) {
        pending.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
    this.child.stderr.on("data", (data: Buffer) => {
      this.#diagnostics = (this.#diagnostics + data.toString()).slice(-8192);
    });
    const rejectAll = (error: Error): void => {
      this.#closed = true;
      for (const pending of this.#pending.splice(0)) pending.reject(error);
    };
    this.child.on("error", rejectAll);
    this.child.on("exit", (code, signal) =>
      rejectAll(
        new Error(`Simulator exited ${code}/${signal}: ${this.#diagnostics}`),
      ),
    );
    this.child.stdin.on("error", rejectAll);
  }
  execute(source: string, entrypoint = true): Promise<PythonResult> {
    if (this.#closed) return Promise.reject(new Error("Simulator is closed"));
    this.executions++;
    return new Promise((resolve, reject) => {
      this.#pending.push({ resolve, reject });
      this.child.stdin.write(JSON.stringify({ source, entrypoint }) + "\n");
    });
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    const closed = new Promise<void>((resolve) =>
      this.child.once("exit", () => resolve()),
    );
    this.child.stdin.end();
    const timeout = setTimeout(() => this.child.kill("SIGKILL"), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(timeout);
    }
  }
}
export const simulatorCapabilities = new Set([
  "documents",
  "literal-length-parameters",
  "fixture-export",
  "saved-fixtures",
  "saved-reopen",
  "saved-revisions",
  "dimensioned-rectangle",
  "camera-state",
  "cad-commands",
  "parameter-crud",
  "parameter-expressions",
  "construction-planes",
  "component-tree",
  "document-units",
  "cloud-inventory",
  "rectangular-extrusion",
  "body-attributes",
  "rectangular-sketch",
  "sketch-coordinate-proof",
]);
export const simulatorFolder = Object.freeze({
  projectId: "sim-project:fixtures",
  folderId: "sim-folder:fixtures",
});

/** Preserve runtime provenance by using the public cad-v1 preparation path. */
export function prepareScenarioHelpers(root: string, request: ScriptRequest) {
  if (!request.helpers) return undefined;
  if (!request.target) throw new Error("Helpers require an owned document");
  const file = path.join(
    request.directory,
    `helpers-${request.requestId.split(":").at(-1)}.py`,
  );
  fs.writeFileSync(file, request.source, { flag: "wx" });
  const { prepareRunScript } = createRequire(path.join(root, "package.json"))(
    "./src/run",
  ) as ReturnType<
    typeof import("../../packages/node-adapters/src/python/run-script").createRunScriptAdapter
  >;
  return prepareRunScript(
    file,
    undefined,
    false,
    request.target.name,
    {
      docId: request.target.creationId,
      ...(request.target.file ? { docFileId: request.target.file.fileId } : {}),
    },
    request.helpers,
  );
}

/** Component profile only. It is explicitly NOT evidence that broker/IPC admission passed. */
export class CheckedSimulatorBackend implements ScenarioBackend {
  readonly identity: string;
  readonly mode = "simulator";
  readonly qualification = "component";
  readonly capabilities = simulatorCapabilities;
  readonly #python: PythonTools;
  readonly #checker: ReturnType<typeof createPythonChecker>;
  readonly #results = new Map<string, Execution>();
  readonly #requests = new Set<string>();
  constructor(
    readonly model: PythonSimulator,
    readonly protocol: Protocol,
    readonly root: string,
    temporaryRoot: string,
  ) {
    this.identity = "component:" + protocol + ":" + model.instanceId;
    this.#python = createRequire(path.join(root, "package.json"))(
      "./src/python",
    ) as PythonTools;
    const definitionsRoot = path.join(root, "dist/runtime/python/typing");
    const lock = record(
      JSON.parse(
        fs.readFileSync(
          path.join(root, "scripts/adsk-refresh/api-lock.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const current = record(
      JSON.parse(
        fs.readFileSync(path.join(definitionsRoot, "current.json"), "utf8"),
      ) as unknown,
    );
    if (current["snapshot"] !== lock["snapshot"])
      throw new Error(
        "Simulator requires the pinned API snapshot; run npm run build",
      );
    this.#checker = this.#python.createPythonChecker({
      typingRoot: path.join(root, "runtime/python/typing"),
      definitionsRoot,
      temporaryRoot,
    });
  }
  fusionPath(local: string): string {
    return local;
  }
  async execute(request: ScriptRequest): Promise<Execution> {
    const key = request.owner.clientId + "/" + request.requestId;
    if (this.#requests.has(key))
      throw new Error(
        "Duplicate simulator request; recover the original result instead",
      );
    this.#requests.add(key);
    const retain = (result: Execution): Execution => {
      this.#results.set(key, result);
      return result;
    };
    if (request.command) {
      return retain(
        await componentCommand(
          this.root,
          request,
          async (call, _tool, manifest) => {
            const source =
              call.object.script +
              (this.protocol === "addin" ? '\nrun("")\n' : "");
            const wire = this.#python.preparePythonArtifact([
              { id: "command", filename: "command.py", role: "user", source },
            ]);
            const artifact = manifest
              ? this.#python.retainPythonOrigin(wire, manifest)
              : wire;
            const check = await this.#checker.check({
              artifact,
              context: { kind: manifest ? "bundle" : "raw" },
              unitContexts: this.#python.pythonUnitContexts(artifact),
            });
            if (check.status !== "passed")
              return {
                failed: true,
                text: "Python admission rejected: " + JSON.stringify(check),
              };
            const result = await this.model.execute(
              source,
              this.protocol === "mcp",
            );
            return {
              failed: !result.success,
              text: result.stdout + (result.success ? "" : result.error),
            };
          },
          this.protocol,
        ),
      );
    }
    // The add-in executes code directly; the official backend calls the run entrypoint.
    const prepared = prepareScenarioHelpers(this.root, request);
    const source =
      (prepared?.script ?? request.source) +
      (this.protocol === "addin" ? '\nrun("")\n' : "");
    const wire = this.#python.preparePythonArtifact([
      { id: "scenario", filename: "scenario.py", role: "user", source },
    ]);
    const artifact = prepared
      ? this.#python.retainPythonOrigin(
          wire,
          this.#python.pythonArtifactManifest(prepared),
        )
      : wire;
    const check = await this.#checker.check({
      artifact,
      context: { kind: prepared ? "bundle" : "raw" },
      unitContexts: this.#python.pythonUnitContexts(artifact),
    });
    if (check.status !== "passed")
      return retain({
        requestId: request.requestId,
        state: "failed",
        sdkSettled: true,
        mayHaveMutated: false,
        stdout: "",
        error: "Python admission rejected: " + JSON.stringify(check),
      });
    const result = await this.model.execute(source, this.protocol === "mcp");
    return retain({
      requestId: request.requestId,
      state: result.success ? "succeeded" : "failed",
      sdkSettled: true,
      mayHaveMutated: true,
      stdout: result.stdout,
      ...(result.success ? {} : { error: result.error }),
    });
  }
  lookup(owner: Owner, requestId: string): Promise<Execution | null> {
    return Promise.resolve(
      this.#results.get(owner.clientId + "/" + requestId) ?? null,
    );
  }
}

/** Both wire protocols over a real loopback HTTP connection, for the real broker profile. */
export async function simulatorEndpoint(model: PythonSimulator): Promise<{
  url: string;
  loseNextToolResponse(): void;
  close(): Promise<void>;
}> {
  let loseNext = false;
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk));
        size += bytes.length;
        if (size > 32 * 1024 * 1024)
          throw new Error("Simulator RPC exceeds byte limit");
        chunks.push(bytes);
      }
      const rpc = record(
        JSON.parse(Buffer.concat(chunks).toString()) as unknown,
      );
      const method = text(rpc["method"]);
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Mcp-Session-Id", "fmcad-simulator-session");
      if (method.startsWith("notifications/")) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (method === "initialize")
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fmcad-test-simulator", version: "1" },
        };
      else if (method === "tools/call") {
        const params = record(rpc["params"]),
          args = record(params["arguments"]);
        const addin = params["name"] === "execute_python";
        if (!addin && params["name"] !== "fusion_mcp_execute")
          throw new Error("Unsupported simulator tool");
        const code = addin
          ? text(args["code"])
          : text(record(args["object"])["script"]);
        const execution = await model.execute(code, !addin);
        if (loseNext) {
          loseNext = false;
          response.destroy();
          return;
        }
        result = {
          isError: !execution.success,
          content: [
            {
              type: "text",
              text: addin
                ? JSON.stringify(execution)
                : execution.stdout + execution.error,
            },
          ],
        };
      } else throw new Error("Unsupported simulator method: " + method);
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc["id"], result }));
    })().catch((error: unknown) => {
      response.writeHead(400).end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Simulator did not bind a TCP endpoint");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    loseNextToolResponse: () => {
      loseNext = true;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
