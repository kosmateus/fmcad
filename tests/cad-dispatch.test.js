"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const current = require("../src/cad");
const previous = require("./fixtures/historical-module.cjs")(
  "5292078741b417d6e921d3252a8bf19b3f0cc15b",
  "src/cad.js",
);
const fakeWsl = require("./fixtures/fake-wsl-platform.cjs");

async function observation(api, client, operation, data, context) {
  try {
    return { result: await api.executeCad(client, operation, data, context) };
  } catch (error) {
    return { error: error.message };
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
    if (after.result) {
      successes++;
      assert.notEqual(after.result.mutation, true, operation);
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
    const data = structuredClone(current.catalog[operation].example);
    if (operation === "document.clear") data.dryRun = true;
    const context = {
      doc: "Owned",
      docId: "owned-id",
      docFileId: "owned-file",
      projectId: "owned-project",
    };
    const traces = [];
    for (const api of [previous, current]) {
      const calls = [];
      const reply = {
        success: true,
        operation,
        result: { sentinel: "same scoped response" },
      };
      const result = await api.executeCad(
        {
          async callTool(...args) {
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
  const data = { ...current.catalog[operation].example };
  assert.deepEqual(
    await current.executeCad(null, operation, data, {}),
    await previous.executeCad(null, operation, data, {}),
  );
});
