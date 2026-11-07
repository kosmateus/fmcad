import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import type { ScenarioBackend, Execution, Protocol } from "./contracts";
import {
  PythonSimulator,
  simulatorCapabilities,
  prepareScenarioHelpers,
} from "./simulator";
import * as programs from "./programs";
const root = path.resolve(__dirname, "../../..");
export async function fixture(t: TestContext, protocol: Protocol = "mcp") {
  const parent = path.join(root, ".test-artifacts/scenario-unit");
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, "case-"));
  const model = new PythonSimulator(root);
  const retained = new Map<string, Execution>();
  t.after(async () => {
    await model.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  // Unit-level lifecycle/model test. Checker and real broker have separate explicit suites.
  const backend: ScenarioBackend = {
    mode: "simulator",
    qualification: "component",
    protocol,
    identity: "unit:" + model.instanceId,
    capabilities: simulatorCapabilities,
    fusionPath: (local) => local,
    async execute(request) {
      const source =
        (prepareScenarioHelpers(root, request)?.script ?? request.source) +
        (protocol === "addin" ? '\nrun("")\n' : "");
      const result = await model.execute(source, protocol === "mcp");
      const execution: Execution = {
        requestId: request.requestId,
        state: result.success ? "succeeded" : "failed",
        sdkSettled: true,
        mayHaveMutated: true,
        stdout: result.stdout,
        ...(result.success ? {} : { error: result.error }),
      };
      retained.set(request.owner.clientId + "/" + request.requestId, execution);
      return execution;
    },
    lookup: (owner, requestId) =>
      Promise.resolve(retained.get(owner.clientId + "/" + requestId) ?? null),
  };
  return { directory, model, backend };
}
export async function remaining(model: PythonSimulator): Promise<unknown> {
  const response = await model.execute(programs.snapshot());
  assert.equal(response.success, true, response.error);
  const line = response.stdout.trim();
  const value: unknown = JSON.parse(line.slice(programs.marker.length));
  return value;
}
