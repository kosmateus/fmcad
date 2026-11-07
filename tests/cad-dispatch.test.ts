import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  CadContext,
  CadData,
  CadOutput,
} from "../packages/core/src/application/cad/contracts.js";
import type { CadClient } from "../src/composition/cad-execution.js";
const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  source: string,
) => unknown;
type CadApi = typeof import("../src/composition/cad-execution.js");
const current = load("./src/cad.js") as CadApi;
const previous = historical(
  "5292078741b417d6e921d3252a8bf19b3f0cc15b",
  "src/cad.js",
) as CadApi;
const fakeWsl = load(
  "./tests/fixtures/fake-wsl-platform.cjs",
) as () => () => void;

async function observation(
  api: CadApi,
  client: CadClient,
  operation: string,
  data: CadData,
  context: CadContext,
): Promise<{ result: CadOutput } | { error: string }> {
  try {
    return { result: await api.executeCad(client, operation, data, context) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

test("all catalog previews retain historical outcomes without submitting SDK work", async (t) => {
  t.after(fakeWsl());
  let calls = 0,
    successes = 0;
  const client = {
    callTool() {
      calls++;
      throw new Error("Unexpected SDK submission in preview");
    },
  };
  for (const [operation, declaration] of Object.entries(current.catalog)) {
    const data = structuredClone(declaration.example);
    const context = {
      doc: "Owned",
      docId: "owned-id",
      docFileId: "owned-file",
      preview: true,
    };
    const beforeInput = structuredClone(data);
    const before = await observation(
      previous,
      client,
      operation,
      data,
      context,
    );
    const after = await observation(
      current,
      client,
      operation,
      structuredClone(beforeInput),
      context,
    );
    assert.deepEqual(after, before, operation);
    if ("result" in after) {
      successes++;
      assert.notEqual(after.result["mutation"], true, operation);
    }
  }
  assert.ok(
    successes > 300,
    "preview comparison must include successful routes, not only validation failures",
  );
  assert.equal(calls, 0);
});

test("public read and mutation routes retain exact one-call artifacts and ownership", async () => {
  for (const operation of [
    "document.status",
    "document.clear",
    "entity.attribute.set",
    "shape.box",
  ]) {
    const data = structuredClone(current.catalog[operation]!.example);
    if (operation === "document.clear") data["dryRun"] = true;
    const context = {
      doc: "Owned",
      docId: "owned-id",
      docFileId: "owned-file",
      projectId: "owned-project",
    };
    const traces: Parameters<CadClient["callTool"]>[][] = [];
    for (const api of [previous, current]) {
      const calls: Parameters<CadClient["callTool"]>[] = [];
      const reply = {
        success: true,
        operation,
        result: { sentinel: "same scoped response" },
      };
      const result = await api.executeCad(
        {
          async callTool(...args: Parameters<CadClient["callTool"]>) {
            calls.push(args);
            return {
              failed: false,
              text: "FMCAD_RESULT " + JSON.stringify(reply),
            };
          },
        },
        operation,
        data,
        context,
      );
      assert.deepEqual(result, reply);
      assert.equal(calls.length, 1);
      assert.ok(calls[0]);
      assert.equal(calls[0][1], "fusion_mcp_execute");
      assert.equal(
        calls[0][0].object.readOnly,
        operation === "document.status" || operation === "document.clear",
      );
      assert.match(calls[0][0].object.script, /owned-id/);
      assert.match(calls[0][0].object.script, /owned-file/);
      traces.push(calls);
    }
    assert.deepEqual(traces[1], traces[0], operation);
  }
});

test("offline capability discovery retains its result without a backend", async () => {
  const operation = "capabilities.inspect";
  const data = { ...current.catalog[operation]!.example };
  assert.deepEqual(
    await current.executeCad(null, operation, data, {}),
    await previous.executeCad(null, operation, data, {}),
  );
});
