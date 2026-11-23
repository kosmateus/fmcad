import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CheckedSimulatorBackend,
  PythonSimulator,
  simulatorEndpoint,
} from "./simulator";
import { parseDocumentInventory } from "./document-inventory";

const root = path.resolve(__dirname, "../../..");

test("component simulator returns the typed public document inventory without script markers", async (t) => {
  const model = new PythonSimulator(root),
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-doc-inventory-")),
    endpoint = await simulatorEndpoint(model),
    name = "Zażółć 中文\n🚀";
  t.after(async () => {
    await endpoint.close();
    await model.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const created = await model.execute(
    `DOC_NAME = None
def run(context):
    import adsk.core
    app = adsk.core.Application.get()
    doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
    doc.name = ${JSON.stringify(name)}`,
  );
  assert.equal(created.success, true, created.error);
  const backend = new CheckedSimulatorBackend(model, "addin", root, directory),
    owner = {
      runId: "simulator-document-inventory",
      scenarioId: "coordinator",
      clientId: "scenario:simulator-document-inventory:coordinator",
    },
    requestId = owner.clientId + ":before",
    execution = await backend.execute({
      owner,
      requestId,
      directory,
      source: "",
      inspectCli: "doc-list-json",
    });
  assert.equal(backend.identity, "component:addin:" + model.instanceId);
  assert.equal(backend.qualification, "component");
  assert.equal(execution.requestId, requestId);
  assert.equal(execution.state, "succeeded", execution.error);
  assert.equal(execution.sdkSettled, true);
  assert.equal(execution.mayHaveMutated, false);
  assert.deepEqual(await backend.lookup(owner, requestId), execution);
  assert.equal(execution.stdout.includes("FMCAD_SCENARIO"), false);
  const inventory = parseDocumentInventory(execution.stdout);
  assert.ok(Array.isArray(inventory["documents"]));
  assert.equal(inventory["documents"].length, 1);
  assert.equal((inventory["documents"] as { name: string }[])[0]?.name, name);

  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "fusion_mcp_read",
        arguments: { queryType: "document", operation: "open" },
      },
    }),
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    result: { isError: boolean; content: { text: string }[] };
  };
  assert.equal(payload.result.isError, false);
  assert.deepEqual(
    parseDocumentInventory(payload.result.content[0]!.text),
    inventory,
  );
});
