import type { ToolRequest, CommandsApi } from "./cad-test-support";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
const load = createRequire(
  path.join(process.cwd(), "tests/document-clear.test.ts"),
);
test.after(load("./fixtures/fake-wsl-platform.cjs")());
const { catalog, executeCad, buildCadScript } = load("../src/cad") as {
  catalog: Record<
    string,
    {
      batchAllowed: boolean;
      inputs: Record<string, unknown>;
      example: Record<string, unknown>;
    }
  >;
  executeCad(
    client: unknown,
    operation: string,
    data: unknown,
    context: unknown,
  ): Promise<{ state: string; mutation: boolean }>;
  buildCadScript(operation: string, data: unknown, context: unknown): string;
};
const { parseCadInput } = load("../src/cad-input") as {
  parseCadInput(
    argv: string[],
    inputs: unknown,
  ): { docFileId: string; data: Record<string, unknown> };
};
const { findCommand } = load("../src/commands") as CommandsApi;
const { detail } = load("../src/help") as {
  detail(...words: string[]): string;
};
const { scriptConfig } = load("./helpers/legacy");

test("document clear routing, identity flags and strict dry-run transport", async () => {
  assert.equal(findCommand(["document", "clear"]).target, "document.clear");
  assert.equal(catalog["document.clear"]!.batchAllowed, false);
  const context = parseCadInput(
    [
      "--doc",
      "Reusable_Test",
      "--doc-file-id",
      "exact-id",
      "--file-id",
      "exact-id",
      "--confirm",
      "true",
      "--dry-run",
      "true",
    ],
    catalog["document.clear"]!.inputs,
  );
  assert.equal(context.docFileId, "exact-id");
  assert.deepEqual(context.data, {
    fileId: "exact-id",
    confirm: true,
    dryRun: true,
  });
  for (const dryRun of [true, false, "true"]) {
    let request: ToolRequest | undefined;
    const client = {
      callTool: async (args: ToolRequest) => {
        request = args;
        return { text: 'FMCAD_RESULT {"success":true,"result":{}}' };
      },
    };
    await executeCad(
      client,
      "document.clear",
      { ...context.data, dryRun },
      context,
    );
    assert.equal(request!.object.readOnly, dryRun === true);
    assert.match(
      request!.object.script,
      /if False:\n        ctx.activate_target\(\)/,
    );
    const scriptRequest = scriptConfig(request!.object.script, [
      "_FMCAD_REQUEST",
    ])._FMCAD_REQUEST;
    assert.equal(scriptRequest.docFileId, "exact-id");
  }
});

test("preview stays outer-only, generated clear handler and caller identity are present", async () => {
  const data = catalog["document.clear"]!.example;
  const client = {
    callTool: () => assert.fail("preview must not call Fusion"),
  };
  const result = await executeCad(client, "document.clear", data, {
    doc: "Model",
    preview: true,
  });
  assert.equal(result.state, "input-validated-only");
  assert.equal(result.mutation, false);
  const source = buildCadScript("document.clear", data, {
    doc: "Model",
    docFileId: data["fileId"],
  });
  assert.match(source, /'document.clear': _document_clear/);
  assert.match(source, /timeline.deleteAllAfterMarker\(\)/);
});

test("document clear help examples include the required cloud pin and match manual data", () => {
  const manual = load("../src/manual/document.json")["document.clear"];
  const help = detail("document", "clear");
  const lines = help
    .split("\n")
    .filter((line) => /fmcad document clear .*--doc Model/.test(line));
  assert.equal(lines.length, manual.examples.length + 1);
  for (const line of lines) {
    assert.match(line, /--doc-file-id DISCOVER_EXACT_DATAFILE_ID/);
    const payload = JSON.parse(line.match(/--data '(.*)'/)![1]!);
    assert.equal(payload.fileId, "DISCOVER_EXACT_DATAFILE_ID");
  }
});
