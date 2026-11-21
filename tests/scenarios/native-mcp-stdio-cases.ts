import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import type { Scenario } from "./runner";
import { record, text } from "./contracts";
import { concurrencyLimit } from "./scheduling";
import { childProcessIdentity } from "./legacy-handoff";
import { queueExecution } from "./queue-backend";
import {
  nativeDiagnosticQueue,
  privateEvidence,
} from "./native-transport-support";

export const nativeMcpStdioCapability = "native-addin-mcp-stdio";

export function nativeMcpStdioEntry(native: {
  root: string;
  buildHash: string;
}): string {
  const { resolveQualifiedLiveRuntime } = createRequire(
    path.join(native.root, "package.json"),
  )("./tests/helpers/qualified-live-runtime") as {
    resolveQualifiedLiveRuntime(): { dist: string; fingerprint: string };
  };
  const runtime = resolveQualifiedLiveRuntime();
  assert.equal(runtime.fingerprint, native.buildHash);
  return path.join(runtime.dist, "bin/fmcad-mcp.js");
}

export function nativeMcpStdioArguments(
  entry: string,
  clientId: string,
  projectDirectory: string,
): string[] {
  return [
    entry,
    "--routing",
    "queue",
    "--client",
    clientId,
    "--project-directory",
    projectDirectory,
  ];
}

export function nativeMcpStdioClient(
  child: ChildProcessWithoutNullStreams,
  trace: (event: Record<string, unknown>) => void,
  signal?: AbortSignal,
  discoveryTimeoutMs = 20000,
) {
  const waiting = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout | undefined;
      finish(outcome: string): void;
    }
  >();
  let nextId = 1,
    errors = "",
    fatal: Error | undefined;
  const fail = (error: Error) => {
    fatal = error;
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer);
      pending.finish("closed");
      pending.reject(error);
    }
    waiting.clear();
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("close", () =>
    fail(
      new Error(
        "MCP stdio closed; inspect the original request, never resubmit: " +
          errors,
      ),
    ),
  );
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString("utf8");
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = record(JSON.parse(line) as unknown);
      if (typeof message["id"] !== "number") return;
      const pending = waiting.get(message["id"]);
      if (!pending) return;
      waiting.delete(message["id"]);
      clearTimeout(pending.timer);
      pending.finish(message["error"] ? "error" : "response");
      if (message["error"])
        pending.reject(new Error(JSON.stringify(message["error"])));
      else pending.resolve(record(message["result"]));
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const abort = () =>
    fail(
      new Error(
        "MCP observation interrupted; inspect the original request, never resubmit",
      ),
    );
  signal?.addEventListener("abort", abort, { once: true });
  return {
    request(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      if (signal?.aborted) abort();
      if (fatal) return Promise.reject(fatal);
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const start = performance.now();
        // Local discovery is bounded. Queued execution includes admission/checker
        // and shared-queue waiting, not just SDK time; observe it until the
        // original response, explicit abort, or child closure, never replay it.
        const timeoutMs =
          method === "initialize" || method === "tools/list"
            ? discoveryTimeoutMs
            : null;
        const meta = record(record(params["_meta"] ?? {})["fmcad"] ?? {});
        const identity = {
          id,
          method,
          ...(typeof params["name"] === "string"
            ? { tool: params["name"] }
            : {}),
          ...(typeof meta["requestId"] === "string"
            ? { requestId: meta["requestId"] }
            : {}),
          timeoutMs,
        };
        trace({ ...identity, stage: "write", monotonicMs: start });
        const finish = (outcome: string) =>
          trace({
            ...identity,
            stage: outcome,
            monotonicMs: performance.now(),
            elapsedMs: performance.now() - start,
          });
        const timer =
          timeoutMs === null
            ? undefined
            : setTimeout(() => {
                waiting.delete(id);
                finish("timeout");
                reject(new Error("MCP smoke timeout: " + errors));
              }, timeoutMs);
        waiting.set(id, { resolve, reject, timer, finish });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
          (error) => {
            if (error) fail(error);
          },
        );
      });
    },
    diagnostics: () => errors,
    dispose() {
      signal?.removeEventListener("abort", abort);
      lines.close();
      fail(
        new Error(
          "MCP observer disposed; inspect original requests without replay",
        ),
      );
    },
  };
}

/** Retained OpenCode stdio entry and assertions, with original-request recovery. */
export function nativeMcpStdioScenarios(owners = 10): Scenario[] {
  concurrencyLimit(owners);
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-mcp-stdio-" + index,
    requires: ["documents", nativeMcpStdioCapability],
    scope: "exclusive-instance",
    lifecycle: "read-only",
    async run(session) {
      const native = await nativeDiagnosticQueue(session);
      const entry = nativeMcpStdioEntry(native);
      const help = spawnSync(process.execPath, [entry, "--help"], {
        cwd: native.root,
        encoding: "utf8",
        timeout: 10000,
      });
      try {
        assert.equal(
          help.status,
          0,
          help.stderr || help.stdout || help.error?.message,
        );
        assert.match(help.stdout, /Usage: fmcad-mcp/u);
      } catch (error) {
        native.queue.dispose();
        throw error;
      }
      const child = spawn(
        process.execPath,
        nativeMcpStdioArguments(
          entry,
          session.report.owner.clientId,
          native.root,
        ),
        {
          cwd: native.root,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const closed = once(child, "close");
      // Observe rejection immediately, while the first request still reports spawn errors.
      void closed.catch(() => undefined);
      const report: Record<string, unknown> = {
        retainedSource: "tests/live-mcp-stdio.js",
        owner: session.report.owner,
        entry,
        startedAt: new Date().toISOString(),
        modelMutationsRequested: false,
        automaticReplay: false,
      };
      const save = () => privateEvidence(session, "mcp-stdio.json", report);
      const timings: Record<string, unknown>[] = [];
      report["timings"] = timings;
      const client = nativeMcpStdioClient(
        child,
        (event) => {
          timings.push(event);
          save();
        },
        session.signal,
      );
      const request = client.request;
      try {
        assert.ok(child.pid, "MCP child identity missing");
        report["child"] = {
          pid: child.pid,
          birth: text(childProcessIdentity.processBirth(child.pid)),
        };
        save(); // Private process identity precedes any stdin request.
        const init = await request("initialize", {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "fmcad-stdio-smoke", version: "1.0" },
        });
        assert.equal(record(init["serverInfo"])["name"], "fmcad");
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }) + "\n",
        );
        const tools = (await request("tools/list", {}))["tools"];
        assert.ok(Array.isArray(tools));
        assert.ok(
          tools.some((tool) => record(tool)["name"] === "execute_python"),
        );
        assert.ok(
          tools.some((tool) => record(tool)["name"] === "fmcad_execute"),
        );
        const code = 'print("FUSION_ADDIN_STDIO_OK")';
        const result = await session.registeredRequest(
          "stdio-execute",
          {
            readOnly: true,
            entry,
            code,
            persistent: false,
            child: report["child"],
            buildHash: native.buildHash,
          },
          async (binding) => {
            // The durable session requestId is written before this physical stdio write.
            let response = await request("tools/call", {
              name: "execute_python",
              arguments: { code, persistent: false },
              _meta: { fmcad: { requestId: binding.requestId } },
            });
            if (
              !response["structuredContent"] ||
              !["QUEUED", "ACCEPTED"].includes(
                String(record(response["structuredContent"])["status"]),
              )
            ) {
              const start = performance.now();
              timings.push({
                stage: "lookup-original",
                requestId: binding.requestId,
                monotonicMs: start,
              });
              save();
              const original = await native.queue.findRequest(
                binding.requestId,
              );
              const job = record(record(original)["job"]);
              assert.equal(job["requestId"], binding.requestId);
              assert.equal(job["clientId"], binding.owner.clientId);
              assert.ok(["succeeded", "failed"].includes(text(job["state"])));
              report["terminal"] = original;
              timings.push({
                stage: "original-settled",
                requestId: binding.requestId,
                jobId: job["id"],
                monotonicMs: performance.now(),
                elapsedMs: performance.now() - start,
              });
              save();
              return {
                value: response,
                execution: queueExecution(
                  original,
                  binding.owner,
                  binding.requestId,
                ),
              };
            }
            const accepted = record(response["structuredContent"]);
            assert.ok(
              ["QUEUED", "ACCEPTED"].includes(text(accepted["status"])),
              "Missing queue admission receipt",
            );
            const jobId = text(accepted["jobId"]);
            report["accepted"] = accepted;
            save();
            for (;;) {
              session.signal?.throwIfAborted();
              const receipt = await request("tools/call", {
                name: "fmcad_queue_result",
                arguments: { jobId },
              });
              const value = record(receipt["structuredContent"]),
                job = record(value["job"]);
              assert.equal(job["id"], jobId);
              assert.equal(job["requestId"], binding.requestId);
              assert.equal(job["clientId"], binding.owner.clientId);
              if (["succeeded", "failed"].includes(text(job["state"]))) {
                assert.ok(
                  record(value["rpc"])["raw"],
                  "Missing owned RPC result; inspect job " + jobId,
                );
                const message = record(
                  JSON.parse(text(record(value["rpc"])["raw"])) as unknown,
                );
                assert.equal(
                  message["error"],
                  undefined,
                  JSON.stringify(message["error"]),
                );
                response = record(message["result"]);
                // Read the same original queue receipt for authoritative SDK settlement.
                const original = await native.queue.findRequest(
                  binding.requestId,
                );
                assert.equal(record(record(original)["job"])["id"], jobId);
                report["terminal"] = value;
                save();
                return {
                  value: response,
                  execution: queueExecution(
                    original,
                    binding.owner,
                    binding.requestId,
                  ),
                };
              }
              assert.ok(
                [
                  "queued",
                  "running",
                  "sending",
                  "preparing",
                  "ready",
                  "processing",
                ].includes(text(job["state"])),
                "Unresolved job; inspect without resubmission: " + jobId,
              );
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          },
        );
        assert.equal(result["isError"], false);
        const content = result["content"];
        assert.ok(Array.isArray(content));
        const payload = record(
          JSON.parse(
            text(
              record(content.find((item) => record(item)["type"] === "text"))[
                "text"
              ],
            ),
          ) as unknown,
        );
        assert.equal(payload["success"], true);
        assert.equal(text(payload["stdout"]).trim(), "FUSION_ADDIN_STDIO_OK");
        report["server"] = init["serverInfo"];
        report["tools"] = tools.length;
        report["scriptOutput"] = text(payload["stdout"]).trim();
        report["status"] = "passed";
      } catch (error) {
        report["status"] = "failed";
        report["error"] = String(error);
        throw error;
      } finally {
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed.catch(() => undefined);
        client.dispose();
        native.queue.dispose();
        report["stderr"] = client.diagnostics();
        report["finishedAt"] = new Date().toISOString();
        save();
      }
    },
  }));
}
