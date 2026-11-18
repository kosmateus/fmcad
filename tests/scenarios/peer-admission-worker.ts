import { runScenarios } from "./runner";
import type { Execution, ScenarioBackend, ScriptRequest } from "./contracts";

const pending = new Map<string, (value: Execution) => void>();
let start: () => void = () => {};
let release: () => void = () => {};
const started = new Promise<void>((resolve) => {
  start = resolve;
});
const released = new Promise<void>((resolve) => {
  release = resolve;
});
process.on("message", (message: { type: string; execution?: Execution }) => {
  if (message.type === "start") start();
  if (message.type === "release") release();
  if (message.execution) {
    pending.get(message.execution.requestId)?.(message.execution);
    pending.delete(message.execution.requestId);
  }
});
const backend: ScenarioBackend = {
  identity: "peer-admission-simulator:v1",
  mode: "simulator",
  qualification: "broker",
  protocol: "addin",
  capabilities: new Set(["documents"]),
  fusionPath: (filename) => filename,
  execute(request: ScriptRequest) {
    return new Promise((resolve) => {
      pending.set(request.requestId, resolve);
      process.send?.({ type: "execute", request });
    });
  },
};
void (async () => {
  await started;
  const reports = await runScenarios(
    backend,
    [
      {
        id: "peer-admission",
        scope: "exclusive-instance",
        requires: ["documents"],
        async run(session) {
          if (process.env["PEER_ADMISSION_ROLE"] === "writer") {
            await session.cadFenced("cad-peer-admission", "shape.box", {
              name: "OwnedBox",
              width: "10 mm",
              depth: "10 mm",
              height: "10 mm",
            });
            process.send?.({ type: "mutated" });
            await released;
          } else {
            process.send?.({ type: "peer-ready" });
            await released;
          }
        },
      },
    ],
    process.env["PEER_ADMISSION_ROOT"]!,
    1,
  );
  process.send?.({ type: "done", reports });
  process.disconnect();
})().catch((error: unknown) => {
  process.send?.({ type: "error", error: String(error) });
  process.exitCode = 1;
  process.disconnect();
});
