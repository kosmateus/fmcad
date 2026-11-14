import assert from "node:assert/strict";
import type {
  ObjectValue,
  ToolResult,
} from "../../packages/node-adapters/src/fusion-transport/contracts";
import type { Scenario } from "./runner";
import { record, text, number } from "./contracts";
import { concurrencyLimit } from "./scheduling";
import {
  nativeDiagnosticQueue,
  diagnosticAddinClient,
  disposeDiagnosticClient,
  privateEvidence,
} from "./native-transport-support";

export const nativeBackendAdapterCapability = "native-addin-adapter-soak";
const snapshotScript = `import adsk.core, json, sys
def run(_context: str):
    app = adsk.core.Application.get()
    frame = sys._getframe()
    frame_depth = 0
    while frame is not None:
        frame_depth += 1
        frame = frame.f_back
    documents = sorted([{"creationId": d.creationId, "name": d.name,
        "isSaved": d.isSaved, "isModified": d.isModified} for d in app.documents if _fmcad_live_visible(d)],
        key=lambda d: d["creationId"])
    print(json.dumps({"documents": documents,
        "activeCreationId": app.activeDocument.creationId if app.activeDocument else None,
        "stdoutType": type(sys.stdout).__name__, "frameDepth": frame_depth}))
`;

/** All retained marker/transport assertions run against the real broker adapter. */
export function nativeBackendAdapterScenarios(
  owners = 10,
  timeoutMs = 60000,
): Scenario[] {
  concurrencyLimit(owners);
  assert.ok(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147482647,
    "timeout-ms must be a positive integer at most 2147482647",
  );
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-backend-adapter-" + index,
    requires: ["documents", nativeBackendAdapterCapability],
    scope: "exclusive-instance",
    lifecycle: "read-only",
    async run(session) {
      const native = await nativeDiagnosticQueue(session);
      const client = diagnosticAddinClient(session, native, timeoutMs);
      const report: Record<string, unknown> = {
        retainedSource: "tests/live-backend-adapter.js",
        owner: session.report.owner,
        backend: "addin",
        transport: native.config["transport"],
        configuredTimeoutMs: native.config["timeoutMs"],
        timeoutMs,
        readOnlyEnforced: client.capabilities.readOnlyEnforced,
        spinupNativeMCP: false,
        modelMutationsRequested: false,
        automaticResubmit: false,
        automaticFallback: client.capabilities.automaticFallback,
        markerTarget: 450,
        markersCompleted: 0,
        initializeCount: 0,
        toolCalls: 0,
        maxResponseFrameBytes: 0,
        maxStdoutBytes: 0,
        maxFrameDepth: 0,
      };
      const stages: {
        name: string;
        status: string;
        startedAt: string;
        durationMs?: number;
        error?: string;
      }[] = [];
      report["stages"] = stages;
      const save = () =>
        privateEvidence(session, "backend-adapter.json", report);
      let stopReason: string | undefined,
        sessionSeen = false,
        clientSession: string | undefined;
      const stop = (signal: string) => {
        stopReason = signal + ": stop after the in-flight request; no resubmit";
      };
      const onInt = () => stop("SIGINT"),
        onTerm = () => stop("SIGTERM");
      process.on("SIGINT", onInt);
      process.on("SIGTERM", onTerm);
      const post = client._post.bind(client);
      client._post = async (payload, sessionId) => {
        if (stopReason) throw new Error(stopReason);
        if (payload["method"] === "initialize") {
          report["initializeCount"] = number(report["initializeCount"]) + 1;
          assert.equal(
            report["initializeCount"],
            1,
            "Unexpected session reinitialization",
          );
        } else {
          assert.ok(sessionSeen, "Request before initialization");
          assert.equal(sessionId, clientSession, "Client session changed");
        }
        if (payload["method"] === "tools/call") {
          const params = record(payload["params"]);
          assert.equal(
            params["name"],
            "execute_python",
            "Unexpected tool or native fallback",
          );
          assert.equal(record(params["arguments"])["persistent"], false);
          report["toolCalls"] = number(report["toolCalls"]) + 1;
        }
        const response = await post(payload, sessionId);
        report["maxResponseFrameBytes"] = Math.max(
          number(report["maxResponseFrameBytes"]),
          Buffer.byteLength(response.raw || "", "utf8"),
        );
        if (payload["method"] === "initialize") {
          clientSession = response.sessionId;
          sessionSeen = true;
          report["clientSession"] = clientSession ?? null;
          report["serverIssuedSessionId"] = Boolean(clientSession);
        }
        return response;
      };
      const call = async (request: ObjectValue, tool?: string) => {
        if (stopReason) throw new Error(stopReason);
        // Queue/SDK budgets remain broker-owned. No racing timer may resubmit.
        const result = await client.callTool(request, tool);
        if (stopReason) throw new Error(stopReason);
        report["maxStdoutBytes"] = Math.max(
          number(report["maxStdoutBytes"]),
          Buffer.byteLength(result.text, "utf8"),
        );
        return result;
      };
      const script = (source: string) =>
        call({
          featureType: "script",
          object: { readOnly: true, script: source },
        });
      const success = (out: ToolResult, expected?: string) => {
        assert.equal(out.failed, false, out.text);
        assert.equal(out.readOnlyRequested, true);
        assert.equal(out.readOnlyEnforced, false);
        if (expected !== undefined)
          assert.equal(out.text.replace(/\r\n/gu, "\n"), expected + "\n");
      };
      const stage = async (name: string, action: () => Promise<void>) => {
        const row: (typeof stages)[number] = {
          name,
          status: "running",
          startedAt: new Date().toISOString(),
        };
        stages.push(row);
        save();
        const start = Date.now();
        try {
          await action();
          row.status = "passed";
        } catch (error) {
          row.status = "failed";
          row.error = String(error);
          throw error;
        } finally {
          row.durationMs = Date.now() - start;
          save();
        }
      };
      const snapshot = async (key: string) => {
        const out = await script(snapshotScript);
        success(out);
        const data = record(JSON.parse(out.text) as unknown);
        assert.ok(Array.isArray(data["documents"]));
        assert.ok(
          Number.isInteger(data["frameDepth"]) &&
            number(data["frameDepth"]) > 0,
        );
        assert.equal(typeof data["stdoutType"], "string");
        report[key] = data;
        report["maxFrameDepth"] = Math.max(
          number(report["maxFrameDepth"]),
          number(data["frameDepth"]),
        );
      };
      try {
        assert.equal(report["readOnlyEnforced"], false);
        assert.equal(report["automaticFallback"], false);
        await stage("before", () => snapshot("before"));
        await stage("document.list bridge", async () => {
          const out = await call(
            { queryType: "document", operation: "open" },
            "fusion_mcp_read",
          );
          success(out);
          const data = record(out.data);
          assert.ok(
            Array.isArray(data["results"]),
            "Missing bridged document results",
          );
          assert.deepEqual(JSON.parse(out.text), data);
          const documents = record(report["before"])["documents"];
          assert.ok(Array.isArray(documents));
          assert.equal(data["results"].length, documents.length);
          report["documentList"] = data;
        });
        await stage("450 sequential markers", async () => {
          for (let ordinal = 1; ordinal <= 450; ordinal++) {
            const marker = "ADAPTER_PROBE_" + ordinal;
            success(
              await script(`def run(_context: str):\n print("${marker}")`),
              marker,
            );
            report["markersCompleted"] = ordinal;
            if (ordinal % 25 === 0) save();
          }
        });
        await stage("unicode and stderr", async () => {
          const unicode = "ADAPTER_UNICODE Zażółć 中文 🚀";
          success(
            await script(
              `def run(_context: str):\n print(${JSON.stringify(unicode)})`,
            ),
            unicode,
          );
          const out = await script(
            'import sys\ndef run(_context: str):\n print("ADAPTER_STDOUT")\n print("ADAPTER_STDERR", file=sys.stderr)',
          );
          success(out, "ADAPTER_STDOUT");
          assert.equal(
            text(out.stderr).replace(/\r\n/gu, "\n"),
            "ADAPTER_STDERR\n",
          );
        });
        await stage("expected Python exception then success", async () => {
          const out = await script(
            'def run(_context: str):\n raise ValueError("ADAPTER_EXPECTED_EXCEPTION")',
          );
          assert.equal(out.failed, true);
          assert.match(out.text, /ValueError/u);
          assert.match(out.text, /ADAPTER_EXPECTED_EXCEPTION/u);
          report["expectedPythonException"] = out.text;
          success(
            await script(
              'def run(_context: str):\n print("ADAPTER_AFTER_EXCEPTION")',
            ),
            "ADAPTER_AFTER_EXCEPTION",
          );
        });
        await stage("unsupported operations", async () => {
          const unsupported: unknown[] = [];
          report["unsupported"] = unsupported;
          for (const [tool, request] of [
            ["fusion_mcp_read", { queryType: "document", operation: "recent" }],
            ["fusion_mcp_read", { queryType: "licensing" }],
            ["fusion_mcp_update", { featureType: "undo" }],
            ["fusion_mcp_update", { featureType: "redo" }],
          ] as const)
            await assert.rejects(call(request, tool), (error) => {
              assert.ok(error instanceof Error);
              assert.match(error.message, /unsupported|unavailable/iu);
              assert.match(error.message, /--backend mcp/u);
              assert.match(error.message, /no .*fallback/iu);
              unsupported.push({ tool, request, error: error.message });
              return true;
            });
        });
        await stage("after and unchanged documents", async () => {
          await snapshot("after");
          assert.deepEqual(
            record(report["after"])["documents"],
            record(report["before"])["documents"],
          );
          assert.equal(
            record(report["after"])["activeCreationId"],
            record(report["before"])["activeCreationId"],
          );
          assert.equal(report["initializeCount"], 1);
          assert.equal(report["markersCompleted"], 450);
          report["singleClientSession"] = true;
        });
        report["status"] = "passed";
      } catch (error) {
        report["status"] = "failed";
        report["error"] = String(error);
        throw error;
      } finally {
        native.queue.dispose();
        disposeDiagnosticClient(native.root, client);
        process.removeListener("SIGINT", onInt);
        process.removeListener("SIGTERM", onTerm);
        report["finishedAt"] = new Date().toISOString();
        save();
      }
    },
  }));
}
