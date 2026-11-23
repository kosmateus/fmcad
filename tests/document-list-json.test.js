"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const load = createRequire(
  path.join(root, "dist/src/document-metadata-read-broker.js"),
);
const { prepareRequest } = load("./dist/composition/execution-request");
const { compileDocumentMetadataRead } = load("./document-metadata-read-broker");
const response = {
  success: true,
  results: [
    {
      name: 'Zażółć 🛠\nDOC creationId=not-an-identity\r\nwith "quotes"',
      creationId: "owned-identity",
      id: null,
      isSaved: false,
      isModified: true,
      isActive: false,
      dataFileError: { message: "Odmowa\nodczytu", code: "E_DATA" },
      extraNativeField: { nested: [null, false, 0, "日本語"] },
    },
  ],
  extraEnvelopeField: "preserve me",
};
function request(json) {
  return JSON.parse(
    JSON.stringify(
      prepareRequest({
        request: {
          kind: "command",
          requestId: "json-request",
          clientId: "json-client",
          cwd: root,
          argv: [
            "--backend",
            "addin",
            "doc",
            "list",
            ...(json ? ["--json"] : []),
          ],
          backend: "addin",
          buildHash: "a".repeat(64),
          inputFiles: [],
        },
      }),
    ),
  );
}
function worker(json, reply) {
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const load = require("node:module").createRequire(${JSON.stringify(path.join(root, "dist/src/document-metadata-read-broker.js"))});
    const {execute} = load("./dist/composition/library-legacy-worker");
    const calls = [];
    const client = {
      server: {backend:"addin"},
      async callTool(args, tool) {
        calls.push({tool,args});
        return ${JSON.stringify(reply)};
      },
      async listTools() { throw Error("unexpected discovery"); },
    };
    execute(${JSON.stringify(request(json))}, client, () => {
      throw Error("unexpected outcome side effect");
    }).then(code => {
      process.stderr.write("TEST_RPC " + JSON.stringify(calls) + "\\n");
      process.exitCode = code;
    }).catch(error => {
      console.error(error);
      process.exitCode = 2;
    });
  `,
    ],
    { cwd: root, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(child.signal, null);
  assert.match(child.stderr, /^TEST_RPC /);
  assert.deepEqual(JSON.parse(child.stderr.slice("TEST_RPC ".length)), [
    {
      tool: "fusion_mcp_read",
      args: { queryType: "document", operation: "open" },
    },
  ]);
  return child;
}
test("public parser → real legacy worker emits lossless native JSON and exactly one typed read", () => {
  const child = worker(true, {
    data: response,
    text: "a human summary",
    failed: false,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), response);
  assert.equal(child.stdout, JSON.stringify(response) + "\n");
});
test("text-only native JSON reply remains lossless", () => {
  const child = worker(true, { text: JSON.stringify(response), failed: false });
  assert.equal(child.status, 0);
  assert.deepEqual(JSON.parse(child.stdout), response);
});
test("default public document output stays text with DOC/DONE", () => {
  const native = {
    success: true,
    results: [
      {
        name: "Plain",
        id: "file-id",
        creationId: "creation-id",
        isActive: true,
        isModified: false,
        isSaved: true,
        dataFileError: { message: "read denied" },
      },
    ],
  };
  const child = worker(false, { data: native, text: "unused", failed: false });
  assert.equal(child.status, 0);
  assert.equal(
    child.stdout,
    'DOC name=Plain id=file-id creationId=creation-id isActive=true isModified=false isSaved=true dataFileError={"message":"read denied"}\nDONE\n',
  );
});
for (const [name, reply] of [
  [
    "native failure",
    {
      data: { success: false, error: "SDK read failed", results: [] },
      text: "failure",
      failed: false,
    },
  ],
  [
    "transport failure",
    { data: response, text: "transport marked failure", failed: true },
  ],
  [
    "missing native success",
    { data: { results: [] }, text: "invalid", failed: false },
  ],
  [
    "invalid results",
    { data: { success: true, results: null }, text: "invalid", failed: false },
  ],
]) {
  test("JSON keeps failed status and body: " + name, () => {
    const child = worker(true, reply);
    assert.equal(child.status, 1);
    assert.deepEqual(JSON.parse(child.stdout), reply.data);
  });
}
test("malformed native reply cannot become an empty successful JSON list", () => {
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const {executeDocumentCommand} = require(${JSON.stringify(path.join(root, "packages/core/dist/application/documents/commands.js"))});
    executeDocumentCommand({kind:"list",json:true}, {
      async call() { return {text:"not json",failed:false}; }
    }).then(out => process.stdout.write(JSON.stringify(out)));
  `,
    ],
    { cwd: root, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout);
  assert.equal(out.code, 1);
  assert.equal(out.stdout, "");
  assert.match(out.stderr, /invalid document list JSON response/);
});
test("text and --json have identical logical RPC and exact transport program, but distinct immutable request hashes", async () => {
  const ports = {
    currentPins: () => ({
      buildHash: "a".repeat(64),
      configHash: "c".repeat(64),
      generation: "json-generation",
    }),
    recheck() {},
  };
  const textRequest = request(false),
    jsonRequest = request(true);
  assert.equal(jsonRequest.payload.flags["--json"], true);
  assert.deepEqual(jsonRequest.payload.rawArgs, ["--json"]);
  const plain = await compileDocumentMetadataRead(textRequest, ports);
  const json = await compileDocumentMetadataRead(jsonRequest, ports);
  assert.ok(plain && json);
  assert.deepEqual(plain.expectedRpc, json.expectedRpc);
  assert.equal(plain.descriptor.rpcHash, json.descriptor.rpcHash);
  assert.equal(plain.descriptor.programHash, json.descriptor.programHash);
  assert.equal(plain.program.source, json.program.source);
  assert.notEqual(plain.descriptor.requestHash, json.descriptor.requestHash);
  json.assertRpc(jsonRequest, json.expectedRpc);
  json.assertProgram(jsonRequest, json.program.source);
  assert.throws(() => json.reverify(textRequest), {
    code: "DOCUMENT_METADATA_READ_UNPROVEN",
  });
});
