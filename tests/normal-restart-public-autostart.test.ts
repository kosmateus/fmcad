import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { once } from "node:events";
const load = createRequire(__filename);
const repo = path.resolve(__dirname, "..");
const qi = load(
  "../src/queue-instance",
) as typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance extends (
  ...args: never[]
) => infer R
  ? R
  : never;
const { QueueState } = load(
  "../src/queue-state",
) as typeof import("../src/queue-state");
const { request } = load("../src/queue-connection") as {
  request(
    dir: string,
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const read = (file: string) =>
  object(JSON.parse(fs.readFileSync(file, "utf8")));

for (const mode of ["new-pid", "reused-sdk-pid", "two-independent-clients"]) {
  test(
    "public MCP automatically restarts settled normal broker: " + mode,
    async (t) => {
      const base = fs.mkdtempSync("/tmp/opencode/nr-public-");
      const stateHome = path.join(base, "s");
      const fixtureRoot = path.join(stateHome, "fmcad");
      fs.mkdirSync(fixtureRoot, { recursive: true });
      const fixture = load(
        "../../tests/fixtures/current-epoch-upgrade.cjs",
      ) as (
        base: string,
        repo: string,
      ) => {
        dir: string;
        pointer: Record<string, unknown>;
        cfg: Record<string, unknown>;
        clientId: string;
        token: string;
      };
      const f = fixture(fixtureRoot, repo);
      for (const name of ["recovery.lock", "atomic-migration.lock"])
        fs.unlinkSync(path.join(f.dir, name));
      const pointer = f.pointer;
      const epochRoot = String(pointer["root"]);
      const oldSdk = {
        pid: mode === "reused-sdk-pid" ? process.pid : 2147483646,
        birth: "dead:previous-sdk",
        version: "fixture",
      };
      pointer["currentInstance"] = oldSdk;
      pointer["restoreActiveCreationId"] = null;
      const qualification = object(pointer["qualificationReceipt"]);
      const qualificationFile = String(qualification["path"]);
      qi.durable(qualificationFile, {
        ...read(qualificationFile),
        currentInstance: oldSdk,
      });
      const { reference } = load("../src/queue-epoch-lineage") as {
        reference(file: string): { path: string; sha256: string };
      };
      pointer["qualificationReceipt"] = reference(qualificationFile);
      qi.durable(path.join(f.dir, "isolated-admission-epoch.json"), pointer);
      const closed = load(
        "../../tests/fixtures/closed-scratch-artifacts.cjs",
      ) as (
        root: string,
        pointer: unknown,
        repo: string,
        mode: string,
      ) => unknown;
      closed(f.dir, pointer, repo, "normal-multidocument");
      const oldState = new QueueState(epochRoot, { recover: false });
      oldState.pause(false);
      while (Object.keys(oldState.data.jobs).length < 155) {
        const id = randomUUID();
        const job = oldState.submit({
          kind: "rpc",
          requestId: id,
          clientId: f.clientId,
          timeoutMs: 1000,
          payload: { jsonrpc: "2.0", id, method: "ping" },
        });
        oldState.next();
        oldState.finish(String(job["id"]), {
          state: "succeeded",
          code: "SYNTHETIC_OLD_TERMINAL",
        });
      }
      const originalJobs = structuredClone(oldState.data.jobs);
      const historicalBytes = fs.readFileSync(
        path.join(f.dir, "queue-state.json"),
      );
      const current = {
        pid: process.pid,
        birth: qi.processBirth(),
        version: "fixture",
        activeCommand: "SelectCommand",
        documents: [
          { id: randomUUID(), fileId: null, isSaved: false, isModified: false },
        ],
      };
      let startupCalls = 0,
        productCalls = 0;
      const server = http.createServer(async (req, res) => {
        try {
          let text = "";
          for await (const chunk of req) text += chunk.toString();
          const payload = object(JSON.parse(text));
          let result: unknown = {};
          if (payload["method"] === "initialize")
            result = {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "SDK0-native-fixture", version: "test" },
            };
          else if (payload["method"] === "notifications/initialized") {
            res.writeHead(202);
            res.end();
            return;
          } else if (payload["method"] === "tools/list")
            result = {
              tools: [
                { name: "fusion_mcp_execute", inputSchema: { type: "object" } },
              ],
            };
          else {
            assert.equal(payload["method"], "tools/call");
            const params = object(payload["params"]);
            assert.equal(params["name"], "fusion_mcp_execute");
            const script = object(object(params["arguments"])["object"])[
              "script"
            ];
            assert.equal(typeof script, "string");
            const units = (
              load(
                "../src/dist/python/source-units",
              ) as typeof import("../packages/node-adapters/src/python/source-units")
            ).prepareWireArtifact(
              path.join(repo, "runtime/python"),
              script as string,
            ).units;
            const code = units.map((unit) => unit.source).join("\n");
            const fileMatch = /_qr_path = ("(?:\\.|[^"\\])*")/.exec(code);
            const bindingMatch =
              /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/.exec(
                code,
              );
            assert.ok(fileMatch && bindingMatch);
            const target: string = JSON.parse(fileMatch[1]!);
            const normalized = target.replaceAll("\\", "/");
            const file =
              normalized.startsWith("//wsl.localhost/") ||
              normalized.startsWith("//wsl$/")
                ? "/" + normalized.split("/").slice(4).join("/")
                : target;
            assert.ok(
              file.startsWith(f.dir + path.sep),
              "The fixture may only write its own native receipts",
            );
            const binding = object(
              JSON.parse(JSON.parse(bindingMatch[1]!) as string),
            );
            if (code.includes("FMCAD_QUEUE_INSTANCE")) {
              if (binding["stage"] === "startup") startupCalls++;
              qi.durable(file, {
                ...binding,
                terminal: true,
                outcome: "succeeded",
                instance: current,
                probeObservation: {
                  schema: "fmcad-instance-probe-v1",
                  identity: current,
                },
              });
            } else {
              assert.ok(code.includes("FUSION_ADDIN_STDIO_OK"));
              productCalls++;
              qi.durable(file, {
                ...binding,
                terminal: true,
                outcome: "succeeded",
                instance: current,
                publicPythonResult: {
                  schema: "fmcad-public-python-result-v1",
                  value: {
                    success: true,
                    stdout: "FUSION_ADDIN_STDIO_OK\n",
                    stderr: "",
                  },
                },
              });
            }
            result = {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ success: true, message: "" }),
                },
              ],
            };
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ jsonrpc: "2.0", id: payload["id"], result }),
          );
        } catch (error) {
          res.writeHead(500);
          res.end(String(error));
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const cfg = {
        ...f.cfg,
        backend: "mcp",
        url: `http://127.0.0.1:${address.port}/mcp`,
        tool: "fusion_mcp_execute",
        routing: "queue",
        transport: "node",
        queue: { autoStart: true, autoRecover: true, startupTimeoutMs: 60000 },
      };
      const config = path.join(base, "config.json");
      fs.writeFileSync(config, JSON.stringify(cfg));
      const hash = qi.buildHash();
      const configHash = qi.brokerConfigHash(cfg);
      const historicalIdentityFile = path.join(f.dir, "instance.json");
      qi.durable(historicalIdentityFile, {
        ...read(historicalIdentityFile),
        configHash,
      });
      pointer["historicalIdentityHash"] = reference(
        historicalIdentityFile,
      ).sha256;
      qi.durable(path.join(f.dir, "isolated-admission-epoch.json"), pointer);
      const pointerBytes = fs.readFileSync(
        path.join(f.dir, "isolated-admission-epoch.json"),
      );
      qi.durable(path.join(epochRoot, "instance.json"), {
        configHash,
        buildHash: hash,
        instance: oldSdk,
      });
      const owner = {
        pid: 2147483647,
        birth: "dead:old-owner",
        nonce: randomUUID(),
        protocol: 2,
      };
      qi.durable(path.join(f.dir, "broker.lock"), owner);
      const binding = {
        brokerNonce: owner.nonce,
        ownerPid: owner.pid,
        ownerBirth: owner.birth,
        buildHash: hash,
        stage: "startup",
      };
      const oldReceipt = path.join(
        f.dir,
        `broker-startup-${owner.nonce}.receipt.json`,
      );
      qi.durable(oldReceipt, {
        ...binding,
        terminal: true,
        outcome: "succeeded",
        instance: oldSdk,
      });
      qi.durable(path.join(f.dir, `broker-lifecycle-${owner.nonce}.json`), {
        owner,
        configHash,
        buildHash: hash,
        stage: "ready",
        binding,
        receipt: oldReceipt,
      });
      const children: ReturnType<typeof spawn>[] = [];
      let passed = false;
      t.after(async () => {
        for (const child of children) child.kill();
        try {
          const marker = read(path.join(f.dir, "broker.lock"));
          if (qi.processBirth(Number(marker["pid"])) === marker["birth"])
            process.kill(Number(marker["pid"]), "SIGTERM");
          await new Promise((resolve) => setTimeout(resolve, 200));
          // Only this simulator-owned daemon; no real Fusion is used by this test.
          if (qi.processBirth(Number(marker["pid"])) === marker["birth"])
            process.kill(Number(marker["pid"]), "SIGKILL");
        } catch {
          /* Own fixture broker may already have released. */
        }
        server.closeAllConnections();
        server.close();
        // Keep only failed fixtures for exact startup-log diagnosis.
        if (passed) fs.rmSync(base, { recursive: true });
      });
      async function publicClient(): Promise<string> {
        const clientId = "live:normal-restart:" + randomUUID();
        const child = spawn(
          process.execPath,
          [
            path.join(repo, "bin/fmcad-mcp.js"),
            "--routing",
            "queue",
            "--client",
            clientId,
          ],
          {
            env: {
              ...process.env,
              XDG_STATE_HOME: stateHome,
              FMCAD_CONFIG: config,
              FMCAD_BACKEND: "mcp",
              FMCAD_PROJECT_DIRECTORY: base,
            },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        children.push(child);
        let errors = "";
        child.stderr!.on("data", (chunk) => {
          errors += String(chunk);
        });
        let id = 0;
        const pending = new Map<
          number,
          {
            resolve(value: Record<string, unknown>): void;
            reject(error: Error): void;
          }
        >();
        readline
          .createInterface({ input: child.stdout! })
          .on("line", (line) => {
            const value = object(JSON.parse(line));
            const waiter = pending.get(Number(value["id"]));
            if (waiter) {
              pending.delete(Number(value["id"]));
              if (value["error"])
                waiter.reject(new Error(JSON.stringify(value["error"])));
              else waiter.resolve(object(value["result"]));
            }
          });
        async function call(method: string, params: unknown) {
          const next = ++id;
          return await new Promise<Record<string, unknown>>(
            (resolve, reject) => {
              const timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      "Public MCP timeout: " + errors + "; fixture=" + base,
                    ),
                  ),
                90000,
              );
              pending.set(next, {
                resolve(value) {
                  clearTimeout(timer);
                  resolve(value);
                },
                reject(error) {
                  clearTimeout(timer);
                  reject(error);
                },
              });
              child.stdin!.write(
                JSON.stringify({ jsonrpc: "2.0", id: next, method, params }) +
                  "\n",
              );
            },
          );
        }
        await call("initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "normal-restart-test", version: "1" },
        });
        child.stdin!.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }) + "\n",
        );
        const accepted = await call("tools/call", {
          name: "execute_python",
          arguments: {
            code: 'print("FUSION_ADDIN_STDIO_OK")',
            persistent: false,
          },
        });
        const jobId = object(accepted["structuredContent"])["jobId"];
        assert.equal(typeof jobId, "string", JSON.stringify(accepted));
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          const response = await call("tools/call", {
            name: "fmcad_queue_result",
            arguments: { jobId },
          });
          const value = object(response["structuredContent"]);
          const job = object(value["job"]);
          if (
            ["succeeded", "failed", "needs_reconciliation"].includes(
              String(job["state"]),
            )
          ) {
            assert.equal(job["state"], "succeeded", JSON.stringify(response));
            const rpc = object(value["rpc"]);
            const result = object(
              object(JSON.parse(String(rpc["raw"])))["result"],
            );
            assert.equal(result["isError"], false);
            const content = result["content"] as { text: string }[];
            assert.equal(
              object(JSON.parse(content[0]!.text))["stdout"],
              "FUSION_ADDIN_STDIO_OK\n",
            );
            return jobId as string;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.fail(
          "Fresh public job did not become terminal; fixture=" + base,
        );
      }
      const jobs = await Promise.all(
        Array.from(
          { length: mode === "two-independent-clients" ? 2 : 1 },
          publicClient,
        ),
      );
      assert.equal(new Set(jobs).size, jobs.length);
      assert.equal(
        productCalls,
        jobs.length,
        "Each fresh request executes once; old jobs never execute",
      );
      assert.equal(
        startupCalls,
        1,
        "Independent client race must select one shared broker",
      );
      assert.equal(
        fs.readdirSync(path.join(f.dir, "normal-restarts")).length,
        1,
      );
      const after = read(path.join(epochRoot, "queue-state.json"));
      const afterJobs = object(after["jobs"]);
      for (const [id, job] of Object.entries(originalJobs))
        assert.deepEqual(afterJobs[id], job);
      assert.equal(Object.keys(afterJobs).length, 155 + jobs.length);
      assert.deepEqual(
        fs.readFileSync(path.join(f.dir, "queue-state.json")),
        historicalBytes,
      );
      assert.deepEqual(
        fs.readFileSync(path.join(f.dir, "isolated-admission-epoch.json")),
        pointerBytes,
      );
      const identity = read(path.join(epochRoot, "instance.json"));
      assert.equal(object(identity["instance"])["birth"], current.birth);
      const auth = { clientId: f.clientId, clientToken: f.token };
      const status = await request(f.dir, { action: "queue-summary", auth });
      assert.equal(status["held"], null);
      const control = object(status["control"]);
      await request(f.dir, {
        action: "stop",
        auth,
        control: {
          requestId: randomUUID(),
          instanceId: control["instanceId"],
          expectedGeneration: control["generation"],
        },
      });
      const releaseDeadline = Date.now() + 5000;
      while (
        fs.existsSync(path.join(f.dir, "broker.lock")) &&
        Date.now() < releaseDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fs.existsSync(path.join(f.dir, "broker.lock")), false);
      passed = true;
    },
  );
}
