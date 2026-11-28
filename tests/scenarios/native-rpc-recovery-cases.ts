import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Scenario, ScenarioSession } from "./runner";
import type { DiagnosticQueue } from "./native-transport-support";
import {
  nativeDiagnosticQueue,
  privateEvidence,
  registeredRpc,
  rpcPayload,
} from "./native-transport-support";
import { record, text, number } from "./contracts";
import { concurrencyLimit } from "./scheduling";
import { queueExecution } from "./queue-backend";

export const nativeRpcRecoveryCapability = "native-addin-rpc-recovery";
type NativeBroker = Awaited<
  ReturnType<typeof import("../../src/queue-broker").serve>
>;
interface Fault {
  readonly marker: string;
  readonly entered: Promise<void>;
  readonly released: Promise<void>;
  dropped: number;
  release(): void;
  enter(): void;
}
export interface NativeRpcRecoveryPreparation {
  readonly config: Record<string, unknown>;
  readonly broker: NativeBroker;
  readonly socket: string;
  arm(marker: string): Fault;
  closeOwned(): Promise<void>;
}

/** Explicit idle-broker profile; never steals or stops an existing broker. */
export async function prepareNativeRpcRecoveryBroker(
  root: string,
  config: Record<string, unknown>,
): Promise<NativeRpcRecoveryPreparation> {
  assert.equal(
    config["backend"],
    "addin",
    "This retained physical recovery fixture is add-in specific",
  );
  const load = createRequire(path.join(root, "package.json"));
  const { queueDirectory, queueSocket } = load(
    "./src/queue-connection",
  ) as typeof import("../../src/entrypoints/queue-connection");
  const directory = queueDirectory();
  assert.ok(
    !fs.existsSync(path.join(directory, "broker.lock")),
    "Drain/stop the idle broker before this isolated physical fault-injection test",
  );
  const { createBrokerTransport } = load(
    "./packages/node-adapters/dist/fusion-transport/broker",
  ) as typeof import("../../packages/node-adapters/src/fusion-transport/broker");
  const { BrokerAddinClient } = load(
    "./packages/node-adapters/dist/fusion-transport/addin",
  ) as typeof import("../../packages/node-adapters/src/fusion-transport/addin");
  const { requestTimeout } = load(
    "./src/request-timeout",
  ) as typeof import("../../packages/node-adapters/src/execution/request-timeout");
  const { resolveRuntimePaths } = load(
    "./src/dist/config-platform",
  ) as typeof import("../../packages/node-adapters/src/config-platform/runtime-paths");
  // The configured real adapter has a broader optional Server.timeoutMs type;
  // this profile validates and pins the required broker timeout below.
  const { serve } = load("./src/queue-broker") as {
    serve(
      config: import("../../src/queue-broker-ports").Config,
      options: Omit<
        import("../../src/queue-broker-ports").Options,
        "createBackend"
      > & {
        createBackend(): import("../../packages/node-adapters/src/fusion-transport/addin").BrokerAddinClient;
      },
    ): Promise<NativeBroker>;
  };
  const version = text(record(load("./package.json"))["version"]);
  const cfg = {
    ...config,
    backend: "addin",
    routing: "queue",
    timeoutMs: number(config["timeoutMs"]),
    queue: {},
  };
  const physical = createBrokerTransport(
    { ...cfg, url: text(config["url"]) },
    {
      version,
      requestTimeout: (server) => number(requestTimeout(server)),
      bridgeSource: () => {
        const assets = resolveRuntimePaths({
          anchor: path.join(root, "src/queue-broker.js"),
        }).assets;
        return (
          fs.readFileSync(path.join(assets, "cad/identity.py"), "utf8") +
          "\n" +
          fs.readFileSync(path.join(assets, "addin-bridge.py"), "utf8")
        );
      },
    },
  );
  assert.ok(physical instanceof BrokerAddinClient);
  const post = physical._post.bind(physical);
  let armed: Fault | undefined;
  physical._post = async (payload, sessionId, controlPlane) => {
    const response = await post(payload, sessionId, controlPlane);
    const params = payload["params"];
    if (armed && params && typeof params === "object") {
      const data = record(params);
      if (
        data["name"] === "execute_python" &&
        text(record(data["arguments"])["code"]).includes(armed.marker)
      ) {
        armed.dropped++;
        armed.enter();
        await armed.released;
        throw Object.assign(
          new Error(
            "Injected lost real Fusion RPC response after physical completion",
          ),
          { code: "ECONNRESET" },
        );
      }
    }
    return response;
  };
  const broker = await serve(cfg, {
    confirmOwnership: true,
    autoReconcile: true,
    createBackend: () => physical,
  });
  return {
    config: cfg,
    broker,
    socket: queueSocket(directory),
    arm(marker) {
      if (armed && armed.dropped !== 1)
        throw new Error("Prior physical fault has not settled exactly once");
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      armed = { marker, entered, released, enter, release, dropped: 0 };
      return armed;
    },
    async closeOwned() {
      armed?.release();
      await broker.close();
    },
  };
}

async function until<T>(
  read: () => T | Promise<T>,
  label: string,
  timeoutMs = 15000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    "Timed out: " + label + "; inspect original jobs, never resubmit",
  );
}
const payload = (code: string) => ({
  jsonrpc: "2.0",
  id: randomUUID(),
  method: "tools/call",
  params: { name: "execute_python", arguments: { code, persistent: false } },
});
const snapshotSource =
  'import adsk.core, json\na=adsk.core.Application.get()\nprint(json.dumps(sorted([dict(id=d.creationId,name=d.name,saved=d.isSaved,modified=d.isModified,active=d==a.activeDocument) for d in a.documents],key=lambda d:d["id"])))';

/** Pure factory. Native planning must never start a broker or contact Fusion. */
export function nativeRpcRecoveryScenarios(
  owners = 10,
  prepared?: NativeRpcRecoveryPreparation,
): Scenario[] {
  concurrencyLimit(owners);
  return Array.from({ length: owners }, (_, index): Scenario => ({
    id: "native-rpc-recovery-" + index,
    requires: ["documents", nativeRpcRecoveryCapability],
    scope: "exclusive-instance",
    lifecycle: "read-only",
    async run(session) {
      assert.ok(
        prepared,
        "Native RPC recovery requires the explicit absent-lock preparation profile",
      );
      const native = await nativeDiagnosticQueue(session);
      const peer = session.createReadonlyPeer("other-client");
      const other = await nativeDiagnosticQueue(peer).catch((error) => {
        native.queue.dispose();
        throw error;
      });
      const report: Record<string, unknown> = {
        retainedSource: "tests/live-rpc-recovery.js",
        owner: session.report.owner,
        peer: peer.report.owner,
        startedAt: new Date().toISOString(),
        backend: "addin",
        realFusion: true,
        modelMutationsRequested: false,
        automaticReplay: false,
        jobs: [],
        tests: [],
      };
      const jobs: string[] = [];
      report["jobs"] = jobs;
      const checks: unknown[] = [];
      report["tests"] = checks;
      const save = () => privateEvidence(session, "rpc-recovery.json", report);
      const call = (
        owner: ScenarioSession,
        queue: DiagnosticQueue,
        phase: string,
        code: string,
        admitted?: () => void,
      ) =>
        registeredRpc(
          owner,
          queue,
          phase,
          payload(code),
          native.buildHash,
          15000,
          (job) => {
            jobs.push(job.id);
            save();
            admitted?.();
          },
        );
      const snapshot = async (phase: string) => {
        const result = await call(session, native.queue, phase, snapshotSource);
        assert.equal(result.job.state, "succeeded");
        const response = rpcPayload(result),
          content = response["content"];
        assert.ok(Array.isArray(content));
        const data = record(
          JSON.parse(
            text(
              record(content.find((item) => record(item)["type"] === "text"))[
                "text"
              ],
            ),
          ) as unknown,
        );
        assert.equal(data["success"], true);
        return JSON.parse(text(data["stdout"])) as unknown;
      };
      let fault: Fault | undefined;
      let first: ReturnType<typeof call> | undefined,
        second: ReturnType<typeof call> | undefined,
        follow: ReturnType<typeof call> | undefined;
      try {
        const armed = prepared.arm(
          "FMCAD_RPC_DROP_" + randomUUID().replaceAll("-", "_"),
        );
        fault = armed;
        report["before"] = await snapshot("before");
        first = call(
          session,
          native.queue,
          "lost-physical-reply",
          "print(" + JSON.stringify(armed.marker) + ")",
        );
        void first.catch(() => undefined);
        await until(
          () => armed.dropped === 1,
          "real Fusion response reached the injection point",
        );
        let admitted = false;
        second = call(
          peer,
          other.queue,
          "after-lost-physical-reply",
          'print("FMCAD_RPC_FOLLOWUP_OK")',
          () => {
            admitted = true;
          },
        );
        void second.catch(() => undefined);
        await until(
          () => admitted,
          "second client admission before releasing physical reply",
        );
        const releasedAt = Date.now();
        fault.release();
        const [lost, next] = await Promise.all([first, second]);
        assert.equal(
          fault.dropped,
          1,
          "Physical operation must never be replayed",
        );
        assert.equal(lost.job.state, "failed");
        assert.equal(lost.job.code, "RESULT_UNAVAILABLE");
        assert.equal(next.job.state, "succeeded");
        assert.ok(
          Date.now() - releasedAt < 10000,
          "Other client must resume promptly after completion proof",
        );
        checks.push({
          name: "lost real physical RPC reply then automatic continuation",
          status: "passed",
          lost: lost.job,
          next: next.job,
          droppedResponses: fault.dropped,
          elapsedMs: Date.now() - releasedAt,
        });
        save();
        const disconnected = await session.registeredRequest(
          "lost-admission-ack",
          {
            readOnly: true,
            buildHash: native.buildHash,
            code: 'print("FMCAD_DISCONNECTED_CALLER_OK")',
            socket: prepared.socket,
          },
          async (binding) => {
            const request = {
              kind: "rpc",
              requestId: binding.requestId,
              backend: "addin",
              cwd: binding.directory,
              timeoutMs: 15000,
              buildHash: native.buildHash,
              payload: payload('print("FMCAD_DISCONNECTED_CALLER_OK")'),
            };
            await new Promise<void>((resolve, reject) => {
              const socket = net.createConnection(prepared.socket);
              socket.once("error", reject);
              socket.once("connect", () =>
                socket.write(
                  JSON.stringify({
                    action: "submit",
                    auth: native.queue.auth,
                    request,
                  }) + "\n",
                  (error) => {
                    socket.destroy();
                    if (error) reject(error);
                    else resolve();
                  },
                ),
              );
            });
            // Original lookup only: loss of the admission acknowledgement never causes a submit retry.
            const durable = await until(async () => {
              const value = await native.queue.findRequest(binding.requestId);
              return value ? record(value) : null;
            }, "job after caller disconnect");
            const job = record(durable["job"]);
            jobs.push(text(job["id"]));
            save();
            assert.equal(job["clientId"], binding.owner.clientId);
            assert.equal(job["requestId"], binding.requestId);
            follow = call(
              peer,
              other.queue,
              "after-lost-admission-ack",
              'print("FMCAD_AFTER_DISCONNECT_OK")',
            );
            void follow.catch(() => undefined);
            const settled = await native.queue.wait(text(job["id"]));
            return {
              execution: queueExecution(
                settled,
                binding.owner,
                binding.requestId,
              ),
              value: settled,
            };
          },
        );
        assert.ok(follow);
        const followed = await follow;
        assert.equal(disconnected.job.state, "succeeded");
        assert.equal(followed.job.state, "succeeded");
        assert.equal(disconnected.job.dispatch?.rpcCount, 1);
        checks.push({
          name: "caller socket disconnected, owned job and next client complete",
          status: "passed",
          owned: disconnected.job,
          next: followed.job,
        });
        report["after"] = await snapshot("after");
        assert.deepEqual(
          report["after"],
          report["before"],
          "User documents or active document changed",
        );
        assert.equal(prepared.broker.status().blocked, null);
        report["status"] = "passed";
      } catch (error) {
        report["status"] = "failed";
        report["error"] = String(error);
        throw error;
      } finally {
        fault?.release();
        // Join already admitted work; this never authorizes a new request or replay.
        await Promise.allSettled(
          [first, second, follow].filter((value) => value !== undefined),
        );
        native.queue.dispose();
        other.queue.dispose();
        report["finishedAt"] = new Date().toISOString();
        save();
      }
    },
  }));
}
