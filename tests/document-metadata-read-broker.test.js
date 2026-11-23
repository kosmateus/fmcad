"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const root = path.resolve(__dirname, "..");
const load = createRequire(
  path.join(root, "dist/src/document-metadata-read-broker.js"),
);
const { compileDocumentMetadataRead, documentMetadataReadRequestHash } = load(
  "./document-metadata-read-broker",
);
const { addinBridgeSource, buildBridgeScript } = load("./addin-bridge");
const { hash: canonicalHash } = load("./dist/core/application/cad/json");
const { prepareRequest } = load("./dist/composition/execution-request");
const digest = (value) => createHash("sha256").update(value).digest("hex");
// Exact immutable 557-byte accepted payload from terminal live job 4adfd353.
// No credentials or current queue state; this fixture never submits work.
const original =
  '{"version":1,"kind":"legacy-command","entry":{"key":"doc list","usage":"doc list","description":"List currently open documents with isActive/isModified/isSaved.","example":"fmcad doc list","flags":{},"minArgs":0,"maxArgs":0,"requiresDoc":false,"kind":"docops","target":"docListCmd"},"args":[],"flags":{},"listing":false,"rawArgs":[],"options":{"headers":{},"config":"/home/kamil/.config/fmcad/config.json","backend":"addin","client":"g0t:doc-list:d0ad3204-0f72-4f5c-a040-783b61e48b67","request-id":"d5ca35c5-5ae5-4a3e-8681-5f4ef73aa27c","timeoutMs":180000}}';
function fixture() {
  const payload = JSON.parse(original);
  const request = {
    kind: "command",
    requestId: payload.options["request-id"],
    clientId: payload.options.client,
    cwd: "/tmp/opencode/metadata-read-private-fixture",
    argv: [
      "--config",
      payload.options.config,
      "--backend",
      "addin",
      "--client",
      payload.options.client,
      "--request-id",
      payload.options["request-id"],
      "--timeout",
      "180000",
      "doc",
      "list",
    ],
    backend: "addin",
    timeoutMs: 180000,
    inputFiles: [],
    buildHash:
      "a1dc6b0da38971f6ba5e512d611bcf0c38b9823a0b14140793142c2266c5f88f",
    payload,
  };
  const current = {
    buildHash: request.buildHash,
    configHash: "c".repeat(64),
    generation: "private-test-generation",
  };
  // Registry flags are part of the full authoritative envelope. Historical
  // accepted bytes remain immutable, while fresh requests use today's entry.
  request.payload = JSON.parse(
    JSON.stringify(
      prepareRequest({
        request: { ...request, payload: undefined },
      }).payload,
    ),
  );
  const ports = { currentPins: () => current, recheck() {} };
  return {
    request,
    current,
    ports,
    compile: () => compileDocumentMetadataRead(request, ports),
  };
}
const unproven = (error) => error.code === "DOCUMENT_METADATA_READ_UNPROVEN";

if (process.argv.includes("--compiler-output-child")) {
  fixture()
    .compile()
    .then((plan) => {
      assert.ok(plan);
      process.stdout.write(JSON.stringify({ compiled: true }) + "\n");
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
} else {
  test("actual accepted doc-list payload compiles one typed logical read and the real ADDIN pre-receipt program", async () => {
    assert.equal(Buffer.byteLength(original), 557);
    assert.equal(
      digest(original),
      "f112582dd39447f72961dadca1bf8d1608831fd0f85e6149d60de2f862c45050",
    );
    const f = fixture(),
      plan = await f.compile();
    assert.ok(plan);
    assert.deepEqual(plan.expectedRpc, {
      method: "callTool",
      tool: "fusion_mcp_read",
      arguments: { queryType: "document", operation: "open" },
    });
    assert.deepEqual(plan.descriptor, {
      version: 1,
      kind: "document-list",
      requestHash: documentMetadataReadRequestHash(f.request),
      generation: f.current.generation,
      rpcHash: canonicalHash(plan.expectedRpc),
      programHash: digest(plan.program.source),
    });
    assert.equal(plan.program.stage, "addin-prepare-post-before-receipt");
    const raw = buildBridgeScript(
      "fusion_mcp_read",
      plan.expectedRpc.arguments,
    );
    assert.ok(plan.program.source.startsWith(raw));
    assert.notEqual(
      plan.program.source,
      raw,
      "Do not label raw bridge bytes as the transport-prepared program",
    );
    assert.notEqual(plan.program.programHash, digest(raw));
    assert.equal(plan.program.programHash, plan.descriptor.programHash);
    assert.ok(addinBridgeSource().length > 0);
    plan.reverify(f.request);
    plan.assertRpc(f.request, structuredClone(plan.expectedRpc));
    plan.assertProgram(f.request, plan.program.source);
    assert.ok(Object.isFrozen(plan));
    assert.ok(Object.isFrozen(plan.descriptor));
    assert.ok(Object.isFrozen(plan.expectedRpc.arguments));
    assert.ok(Object.isFrozen(plan.program));
    assert.equal("submit" in plan, false);
    assert.equal("grant" in plan, false);
  });
  test("historical accepted payload cannot bypass changed authoritative registration", async () => {
    const f = fixture();
    f.request.payload = JSON.parse(original);
    await assert.rejects(f.compile(), unproven);
  });

  test("typed compiler does not print or open an SDK session while deriving the read plan", () => {
    const child = spawnSync(
      process.execPath,
      [__filename, "--compiler-output-child"],
      {
        cwd: root,
        env: process.env,
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '{"compiled":true}\n');
    assert.equal(child.stderr, "");
  });

  for (const argv of [
    ["doc", "close", "--discard"],
    ["doc", "open", "owned"],
    ["doc", "save"],
    ["run", "/never-open.py", "--args-file", "/never-read.json"],
    ["entity", "list", "--file", "/never-read-cad.json"],
    ["call", "execute_python", '{"code":"print(1)"}'],
  ]) {
    test(
      "non-list command never gets a read contract: " +
        argv.slice(0, 2).join(" "),
      async () => {
        const f = fixture();
        f.request.argv = argv;
        assert.equal(await f.compile(), null);
      },
    );
  }
  test("raw/native RPC never gets a CLI read contract", async () => {
    const f = fixture();
    f.request.kind = "rpc";
    f.request.payload = {
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "execute_python", arguments: { code: "print(1)" } },
    };
    assert.equal(await f.compile(), null);
  });

  for (const [label, change] of [
    [
      "missing payload",
      (r) => {
        delete r.payload;
      },
    ],
    [
      "forged entry",
      (r) => {
        r.payload.entry.target = "docCloseCmd";
      },
    ],
    [
      "readonly assertion",
      (r) => {
        r.payload.readonly = true;
      },
    ],
    [
      "unknown field",
      (r) => {
        r.payload.extra = true;
      },
    ],
    [
      "version",
      (r) => {
        r.payload.version = 2;
      },
    ],
    [
      "arguments",
      (r) => {
        r.payload.args.push("foreign");
      },
    ],
    [
      "config",
      (r) => {
        r.payload.options.config = "/different/config.json";
      },
    ],
    [
      "argv",
      (r) => {
        r.argv.push("--discard");
      },
    ],
    [
      "request file",
      (r) => {
        r.inputFiles.push({ path: "/private", sha256: "a".repeat(64) });
      },
    ],
    [
      "foreign build",
      (r) => {
        r.buildHash = "b".repeat(64);
      },
    ],
    [
      "foreign backend",
      (r) => {
        r.backend = "mcp";
      },
    ],
  ]) {
    test("canonical compilation denies " + label, async () => {
      const f = fixture();
      change(f.request);
      await assert.rejects(f.compile());
    });
  }
  for (const field of ["buildHash", "configHash", "generation"]) {
    test("runtime revalidation denies stale " + field, async () => {
      const f = fixture(),
        plan = await f.compile();
      assert.ok(plan);
      f.current[field] =
        field === "generation" ? "new-generation" : "f".repeat(64);
      assert.throws(() => plan.reverify(f.request), unproven);
      assert.throws(
        () => plan.assertRpc(f.request, plan.expectedRpc),
        unproven,
      );
      assert.throws(
        () => plan.assertProgram(f.request, plan.program.source),
        unproven,
      );
    });
  }
  test("request hash excludes only descriptive metadata; mutation of accepted meaning is rejected", async () => {
    const f = fixture(),
      plan = await f.compile();
    assert.ok(plan);
    const renamed = { ...f.request, description: "A different UI label" };
    assert.equal(
      documentMetadataReadRequestHash(renamed),
      plan.descriptor.requestHash,
    );
    plan.reverify(renamed);
    const changed = structuredClone(f.request);
    changed.payload.options.config = "/changed-after-acceptance";
    assert.throws(() => plan.reverify(changed), unproven);
    assert.throws(
      () => plan.assertProgram(changed, plan.program.source),
      unproven,
    );
  });
  test("actual RPC/source checks reject substitution and do not authorize the final dynamic wire", async () => {
    const f = fixture(),
      plan = await f.compile();
    assert.ok(plan);
    for (const actual of [
      { ...plan.expectedRpc, tool: "execute_python" },
      {
        ...plan.expectedRpc,
        arguments: { queryType: "document", operation: "save" },
      },
      {
        ...plan.expectedRpc,
        arguments: { ...plan.expectedRpc.arguments, readonly: true },
      },
    ])
      assert.throws(() => plan.assertRpc(f.request, actual), unproven);
    for (const source of [
      buildBridgeScript("fusion_mcp_read", plan.expectedRpc.arguments),
      plan.program.source + "\n# substituted",
      "# dynamic receipt/native guard\n" + plan.program.source,
    ])
      assert.throws(() => plan.assertProgram(f.request, source), unproven);
  });
  test("asynchronous owner checks cannot masquerade as a synchronous dispatch fence", async () => {
    const f = fixture();
    f.ports.recheck = () => Promise.resolve();
    await assert.rejects(f.compile(), unproven);
  });
  test("owner revocation is rechecked on every repeatable fence", async () => {
    const f = fixture(),
      plan = await f.compile();
    assert.ok(plan);
    f.ports.recheck = () => {
      throw Error("current owner was revoked");
    };
    assert.throws(() => plan.reverify(f.request), /revoked/);
  });
  test("source revalidation rejects a changed owned staged bridge and permits restored original bytes", async () => {
    const f = fixture(),
      plan = await f.compile();
    assert.ok(plan);
    const asset = path.join(root, "dist/assets/addin-bridge.py");
    const previous = fs.readFileSync(asset);
    try {
      fs.appendFileSync(asset, "\n# changed owned offline fixture\n");
      assert.throws(() => plan.reverify(f.request), unproven);
      assert.throws(
        () => plan.assertProgram(f.request, plan.program.source),
        unproven,
      );
    } finally {
      fs.writeFileSync(asset, previous);
    }
    plan.reverify(f.request);
  });
  test("generation or request mutation during asynchronous preparation is rejected before returning authority", async () => {
    const f = fixture();
    const pending = f.compile();
    f.current.generation = "changed-during-prepare";
    await assert.rejects(pending, unproven);
    const g = fixture();
    const changed = g.compile();
    g.request.payload.flags["--discard"] = true;
    await assert.rejects(changed, unproven);
  });
}
