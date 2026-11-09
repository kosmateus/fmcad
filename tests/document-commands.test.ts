import { spawnSync } from 'node:child_process';
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
const load = createRequire(
  path.join(process.cwd(), "tests/document-commands.test.ts"),
);
const { createDocumentService } = load("../src/docops") as {
  createDocumentService(
    client: {
      callTool(
        data: { queryType?: string; object: { script: string } },
        tool: string,
      ): Promise<unknown>;
    },
    toWindowsPath?: (value: string) => string,
  ): {
    execute(
      command: unknown,
    ): Promise<{ code: number; stdout: string; stderr: string }>;
  };
};
test("docops forwards the dedicated review shot handler without a second screenshot pipeline", () => {
  assert.equal(
    load("../src/docops").shotCmd,
    load("../src/shot").shotCmd,
  );
});

test("typed document service dispatches actual commands without CLI imports or stdout", async () => {
  const calls: {
    data: { queryType?: string; object: { script: string } };
    tool: string;
  }[] = [];
  const client = {
    callTool: async (
      data: { queryType?: string; object: { script: string } },
      tool: string,
    ) => {
      calls.push({ data, tool });
      return data.queryType === "document"
        ? { text: "", data: { results: [{ name: "Part", id: "exact-id" }] } }
        : { text: "accepted" };
    },
  };
  const service = createDocumentService(client, (value) => "W:" + value);
  assert.deepEqual(await service.execute({ kind: "list" }), {
    code: 0,
    stdout: "DOC name=Part id=exact-id\nDONE\n",
    stderr: "",
  });
  assert.equal((await service.execute({ kind: "open", name: "Part" })).code, 0);
  assert.deepEqual(calls.at(-1), {
    tool: "fusion_mcp_execute",
    data: {
      featureType: "document",
      object: { operation: "open", fileId: "exact-id" },
    },
  });
  const before = calls.length;
  assert.equal(
    (await service.execute({ kind: "close", save: false, discard: false }))
      .code,
    1,
  );
  assert.equal(calls.length, before);
  await service.execute({ kind: "close", save: false, discard: true });
  assert.deepEqual(calls.at(-1)!.data.object, {
    operation: "close",
    userConfirmedCloseWithoutSave: true,
  });
  await service.execute({
    kind: "download",
    name: "Part",
    output: "/target.step",
  });
  // Typed Python adds annotations; compare the exact assignment values.
  const parsed = spawnSync('python3', ['-B', path.join(process.cwd(), 'tests/helpers/python_config.py')], {
    input: JSON.stringify({ script: calls.at(-1)!.data.object.script, names: ['FILE_ID', 'DIR_PATH'] }),
    encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(parsed.error);
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(JSON.parse(parsed.stdout), { FILE_ID: 'exact-id', DIR_PATH: 'W:/target.step' });
  assert(
    !Object.keys(load.cache).some((file) => /\/src\/cli\.js$/.test(file)),
  );
});
test("typed document service never retries rejected or unknown SDK mutations", async () => {
  let calls = 0;
  const failed = createDocumentService({
    callTool: async () => {
      calls++;
      return { failed: true, text: "not accepted" };
    },
  });
  assert.equal((await failed.execute({ kind: "save" })).code, 1);
  assert.equal(calls, 1);
  const unknown = createDocumentService({
    callTool: async () => {
      calls++;
      throw Error("ack lost");
    },
  });
  await assert.rejects(unknown.execute({ kind: "save" }), /ack lost/);
  assert.equal(calls, 2);
});
