import type { Client } from "../src/queue-broker-ports.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";

import {
  object,
  array,
  field,
  string,
  present,
} from "./modeling-unit-test-support.js";
const fixtureDirectory = path.join(process.cwd(), "tests");
const load = createRequire(
  path.join(fixtureDirectory, "build-preflight-rejection.test.ts"),
);
const restorePlatform = (
  load("./fixtures/fake-wsl-platform.cjs") as () => () => void
)();
test.after(restorePlatform);
const { request } = load(
  "../src/queue-connection",
) as typeof import("../src/entrypoints/queue-connection.js");
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

test("a local build mismatch before sending preflight is terminal not_started, never a false unknown hold", async (t) => {
  const parent = path.join(fixtureDirectory, "..", ".test-artifacts");
  fs.mkdirSync(parent, { recursive: true });
  const work = fs.mkdtempSync(path.join(parent, "build-guard-"));
  const runtime = path.join(work, "runtime");
  fs.mkdirSync(runtime);
  for (const file of ["package.json", "src", "assets", "bin", "runtime"])
    fs.cpSync(
      path.join(fixtureDirectory, "..", file),
      path.join(runtime, file),
      { recursive: true },
    );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qlocal-"));
  let probes = 0,
    sdk = 0;
  const instance = {
    pid: 123,
    birth: "mock:123",
    version: "mock",
    activeCommand: "SelectCommand",
    documents: [],
  };
  const physical: Client = {
    _openSession: async () => assert.fail("unexpected SDK session"),
    listTools: async () => assert.fail("unexpected tool discovery"),
    executeUiGuardedScript: async () => assert.fail("unexpected UI mutation"),
    server: { timeoutMs: 5000 },
    _parse: JSON.parse,
    async _post() {
      sdk++;
      throw Error("No SDK operation may be dispatched");
    },
    async callTool() {
      probes++;
      return {
        failed: false,
        text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(instance),
      };
    },
  };
  const { serve } = load(
    path.join(runtime, "src/queue-broker"),
  ) as typeof import("../src/queue-broker.js");
  const broker = await serve(
    { backend: "mcp", timeoutMs: 5000 },
    {
      dir,
      confirmOwnership: true,
      createBackend: () => physical,
      pollMs: 3000,
    },
  );
  t.after(async () => {
    await broker.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });
  const auth = { clientId: "a", clientToken: "secret-a" };
  await request(dir, { action: "register", ...auth });
  const script = path.join(dir, "operation.py");
  fs.writeFileSync(script, "def run(context): pass\n");
  const job = await request(dir, {
    action: "submit",
    auth,
    request: {
      kind: "command",
      requestId: randomUUID(),
      argv: ["run", script],
      cwd: dir,
      timeoutMs: 5000,
      inputFiles: [
        {
          path: script,
          sha256: createHash("sha256")
            .update(fs.readFileSync(script))
            .digest("hex"),
        },
      ],
    },
  });
  const read = () =>
    request(dir, { action: "result", auth, jobId: field(job, "id") });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    if (field(await read(), "job", "state") === "queued") {
      ready = true;
      break;
    }
    await sleep(10);
  }
  assert.equal(
    ready,
    true,
    "Worker finished preparation before the first scheduler turn",
  );
  fs.appendFileSync(
    path.join(runtime, "src/help.js"),
    "\n// Controlled local build change; no product files.\n",
  );
  let result: unknown;
  for (let i = 0; i < 300; i++) {
    result = await read();
    if (field(result, "job", "state") === "failed") break;
    await sleep(10);
  }
  assert.equal(field(result, "job", "state"), "failed");
  assert.equal(field(result, "job", "code"), "BUILD_CHANGED_BEFORE_EXECUTION");
  assert.equal(field(result, "job", "executionOutcome"), "not_started");
  assert.equal(field(result, "job", "mayHaveMutated"), false);
  assert.equal(broker.status().blocked, null);
  assert.equal(broker.status().lease, null);
  assert.equal(
    probes,
    1,
    "Only the startup probe was sent; preflight never entered the SDK",
  );
  assert.equal(sdk, 0);
});

test("a build change after fully receipted idle SDK completion does not invent an unknown postflight call", async (t) => {
  const parent = path.join(fixtureDirectory, "..", ".test-artifacts");
  fs.mkdirSync(parent, { recursive: true });
  const work = fs.mkdtempSync(path.join(parent, "post-build-")),
    runtime = path.join(work, "runtime");
  fs.mkdirSync(runtime);
  for (const file of ["package.json", "src", "assets", "bin", "runtime"])
    fs.cpSync(
      path.join(fixtureDirectory, "..", file),
      path.join(runtime, file),
      { recursive: true },
    );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qpost-"));
  const qi = load(path.join(runtime, "src/queue-instance")) as ReturnType<
    typeof import("../packages/node-adapters/src/execution/queue-instance.js").createQueueInstance
  >;
  let probes = 0,
    sdk = 0;
  let lastScript: string | undefined;
  const identity = {
    pid: 123,
    birth: "mock:123",
    version: "mock",
    activeCommand: "SelectCommand",
    documents: [],
  };
  const physical: Client = {
    _openSession: async () => assert.fail("unexpected SDK session"),
    listTools: async () => assert.fail("unexpected tool discovery"),
    executeUiGuardedScript: async () => assert.fail("unexpected UI mutation"),
    server: { timeoutMs: 5000 },
    _parse: JSON.parse,
    async _post(payload) {
      sdk++;
      const script = string(
        field(payload, "params", "arguments", "object", "script"),
      );
      lastScript = script;
      const binding = object(
        JSON.parse(
          string(
            JSON.parse(
              present(
                present(
                  script.match(
                    /_qr_binding_value = _qr_cast\(object, _qr_json.loads\(("(?:\\.|[^"\\])*")\)/,
                  ),
                )[1],
              ),
            ),
          ),
        ),
      );
      const receipt = string(
        JSON.parse(
          present(present(script.match(/_qr_path = ("(?:\\.|[^"\\])*")/))[1]),
        ),
      )
        .replace(/^\\\\wsl\$\\[^\\]+/, "")
        .replaceAll("\\", "/");
      qi.durable(receipt, {
        ...binding,
        terminal: true,
        outcome: "succeeded",
        instance: identity,
      });
      fs.appendFileSync(
        path.join(runtime, "src/help.js"),
        "\n// controlled change after SDK receipt\n",
      );
      return {
        status: 200,
        raw: JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { content: [{ type: "text", text: "done" }] },
        }),
      };
    },
    async callTool(value) {
      if (
        string(field(value, "object", "script")).includes(
          "FMCAD_QUEUE_INSTANCE",
        )
      ) {
        probes++;
        return {
          failed: false,
          text: "FMCAD_QUEUE_INSTANCE " + JSON.stringify(identity),
        };
      }
      const response = await this._post({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "fusion_mcp_execute", arguments: value },
      });
      return {
        failed: false,
        text: string(
          field(JSON.parse(response.raw), "result", "content", 0, "text"),
        ),
      };
    },
  };
  const broker = await (
    load(
      path.join(runtime, "src/queue-broker"),
    ) as typeof import("../src/queue-broker.js")
  ).serve(
    { backend: "mcp", timeoutMs: 5000 },
    { dir, confirmOwnership: true, createBackend: () => physical, pollMs: 5 },
  );
  t.after(async () => {
    await broker.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });
  const auth = { clientId: "a", clientToken: "private-a" };
  await request(dir, { action: "register", ...auth });
  const file = path.join(dir, "operation.py");
  fs.writeFileSync(file, "def run(context): pass\n");
  const job = await request(dir, {
    action: "submit",
    auth,
    request: {
      kind: "command",
      requestId: randomUUID(),
      argv: ["run", file],
      cwd: dir,
      timeoutMs: 5000,
      inputFiles: [
        {
          path: file,
          sha256: createHash("sha256")
            .update(fs.readFileSync(file))
            .digest("hex"),
        },
      ],
    },
  });
  let result: unknown;
  for (let i = 0; i < 500; i++) {
    result = await request(dir, {
      action: "result",
      auth,
      jobId: field(job, "id"),
    });
    if (field(result, "job", "state") === "failed") break;
    await sleep(10);
  }
  assert.equal(field(result, "job", "code"), "SDK_COMPLETE_BUILD_CHANGED");
  assert.equal(field(result, "execution", "sdkSettled"), true);
  assert.equal(field(result, "execution", "postflightSubmitted"), false);
  assert.equal(field(result, "job", "mayHaveMutated"), true);
  assert.equal(broker.status().blocked, null);
  assert.equal(broker.status().lease, null);
  assert.equal(sdk, 1);
  assert.equal(probes, 2);
  const jobDir = path.join(dir, "jobs", string(field(job, "id")));
  const rpcFile = fs
    .readdirSync(jobDir)
    .find((name) => /^rpc-.*\.json$/.test(name));
  const record = qi.readJson(path.join(jobDir, present(rpcFile)));
  assert.equal(
    field(record, "pythonArtifact", "sha256"),
    createHash("sha256").update(present(lastScript)).digest("hex"),
  );
  assert.match(
    string(field(record, "binding", "sourceHash")),
    /^[a-f0-9]{64}$/,
  );
  assert.equal(
    field(record, "remoteReceipt", "sourceHash"),
    field(record, "binding", "sourceHash"),
  );
  assert.ok(
    array(field(record, "pythonArtifact", "units")).some(
      (unit) => field(unit, "filename") === "<fmcad-queue>",
    ),
  );
  assert.ok(
    array(field(record, "pythonArtifact", "units")).some(
      (unit) => field(unit, "filename") === "<fmcad-wire>",
    ),
  );
});
