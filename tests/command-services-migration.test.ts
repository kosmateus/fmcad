import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import type { ParsedCadWorkerCommand } from "@fmcad/core";
import type { CommandBackend } from "../src/composition/cad-service";

const root = path.resolve(__dirname, "../..");
const load = createRequire(path.join(root, "package.json"));
type Service = typeof import("../src/composition/cad-service");
type Catalog = typeof import("../src/composition/catalog-execution");
type Invocation =
  typeof import("../packages/node-adapters/src/execution/invocation");
const current = load("./src/cad-service.js") as Service;
const catalog = load("./src/catalog/execute.js") as Catalog;
const invocation = load("./src/invocation.js") as Invocation;
const historical = load("./tests/fixtures/historical-module.cjs") as (
  revision: string,
  file: string,
) => unknown;
const previous = historical(
  "2a51000dabc73e16bf7eec560b563dc8638db2fe",
  "src/cad-service.js",
) as Service;
const oldCatalog = historical(
  "2a51000dabc73e16bf7eec560b563dc8638db2fe",
  "src/catalog/execute.js",
) as Catalog;
const oldInvocation = historical(
  "2a51000dabc73e16bf7eec560b563dc8638db2fe",
  "src/invocation.js",
) as Invocation;

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "command-services-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "source.py"),
    source = 'ARGS = []\nDOC_NAME = ""\ndef run(_context):\n    print(ARGS)\n';
  await fs.writeFile(file, source);
  const command: ParsedCadWorkerCommand = {
    kind: "run",
    purpose: "Owned request",
    request: {
      name: file,
      doc: "Owned model",
      args: { text: "Zażółć 🧪" },
      hasArgs: true,
      identity: { docId: "creation-A", docFileId: "file-A" },
    },
  };
  return { directory, file, source, command };
}
function streams() {
  let stdout = "",
    stderr = "";
  return {
    io: {
      stdout: {
        write(value: string) {
          stdout += value;
        },
      },
      stderr: {
        write(value: string) {
          stderr += value;
        },
      },
    },
    output: () => ({ stdout, stderr }),
  };
}

test("parsed commands preserve payloads, policy arguments and caller-owned input", async (t) => {
  const f = await fixture(t);
  const commands: ParsedCadWorkerCommand[] = [
    f.command,
    {
      ...f.command,
      output: {
        path: path.join(f.directory, "out.json"),
        format: "json",
        pretty: true,
      },
    },
    { kind: "run", request: { ...f.command.request, helperVersion: "cad-v1" } },
    {
      kind: "run",
      request: {
        ...f.command.request,
        helperVersion: "cad-v1",
        identity: { ...f.command.request.identity, readOnly: true },
      },
    },
    {
      kind: "cad",
      operation: "entity.list",
      data: {},
      context: {
        doc: "Owned model",
        docId: "creation-A",
        component: null,
        projectId: null,
      },
      json: true,
      purpose: "inspect owned document",
    },
  ];
  for (const command of commands) {
    const before = structuredClone(command);
    assert.deepEqual(
      current.fromParsedCommand(command),
      previous.fromParsedCommand(command),
    );
    assert.deepEqual(command, before);
  }
  assert.equal(await fs.readFile(f.file, "utf8"), f.source);
});

for (const outcome of [
  "success",
  "failed",
  "exception",
  "guard",
  "unknown-guard",
  "readonly",
  "helpers",
] as const) {
  test(`command migration preserves ${outcome} SDK bytes, provenance, streams and stage ordering`, async (t) => {
    const f = await fixture(t),
      observations = [];
    const command = structuredClone(f.command);
    if (outcome === "readonly") command.request.identity.readOnly = true;
    if (outcome === "helpers") command.request.helperVersion = "cad-v1";
    const request = current.fromParsedCommand(command);
    for (const api of [previous, current]) {
      const output = streams(),
        calls: unknown[] = [],
        events: string[] = [],
        outcomes: unknown[] = [];
      const backend: CommandBackend = {
        capabilities: { backend: "addin" },
        server: { headers: { "X-Key": "private-secret" } },
        async callTool(...args) {
          await Promise.resolve();
          calls.push({
            argsHash: createHash("sha256")
              .update(JSON.stringify(args))
              .digest("hex"),
            context: structuredClone(invocation.context.getStore()),
          });
          events.push("submit");
          if (outcome === "exception")
            throw Object.assign(new Error("reply lost private-secret"), {
              stdout: "partial\n",
            });
          if (outcome === "guard" || outcome === "unknown-guard")
            return {
              text: "guard",
              failed: true,
              uiGuard: {
                status:
                  outcome === "guard" ? "rejected-before-mutation" : "unknown",
                notStarted: outcome === "guard",
              },
            };
          return {
            text: "native output",
            stderr: "private-secret warning",
            failed: outcome === "failed",
            data: { success: outcome !== "failed" },
          };
        },
      };
      const code = await api.execute(
        request,
        backend,
        (value) => outcomes.push(value),
        output.io,
        {
          stageDependencies: {
            helper: {
              plan() {
                events.push("plan");
              },
              context() {
                events.push("context");
                return { fixture: "stage" };
              },
              started() {
                events.push("started");
              },
            },
          },
        },
      );
      assert.equal(calls.length, 1);
      assert.equal(
        code,
        ["success", "readonly", "helpers"].includes(outcome) ? 0 : 1,
      );
      assert.deepEqual(
        events,
        outcome === "helpers"
          ? ["plan", "context", "started", "submit"]
          : ["submit"],
      );
      assert.doesNotMatch(output.output().stderr, /private-secret/);
      observations.push({ code, calls, events, outcomes, ...output.output() });
    }
    assert.deepEqual(observations[1], observations[0]);
    assert.equal(await fs.readFile(f.file, "utf8"), f.source);
  });
}

for (const kind of ["preview", "native", "missing-result"] as const) {
  test(`catalog migration preserves ${kind} results and never retries a native call`, async () => {
    const input = {
      version: 1 as const,
      kind: "cad" as const,
      operation: "entity.list",
      data: {},
      doc: "Owned model",
      docId: "creation-A",
      docFileId: "file-A",
      preview: kind === "preview",
      purpose: "inspect A",
    };
    const observations = [];
    for (const api of [oldCatalog, catalog]) {
      const calls: unknown[] = [],
        outcomes: unknown[] = [];
      const backend: CommandBackend = {
        async callTool(...args) {
          calls.push({
            argsHash: createHash("sha256")
              .update(JSON.stringify(args))
              .digest("hex"),
            context: structuredClone(invocation.context.getStore()),
          });
          return {
            text:
              kind === "missing-result"
                ? "unconfirmed"
                : 'FMCAD_RESULT {"success":true,"result":{"value":42}}',
          };
        },
      };
      let result: unknown;
      try {
        result = await api.executeInvocation(
          input,
          kind === "preview" ? null : backend,
          (value) => outcomes.push(value),
        );
      } catch (error) {
        assert.equal(kind, "missing-result");
        assert.ok(error instanceof Error);
        result = { error: error.message };
      }
      assert.equal(calls.length, kind === "preview" ? 0 : 1);
      assert.equal(outcomes.length, kind === "missing-result" ? 0 : 1);
      observations.push({ result, calls, outcomes });
    }
    assert.deepEqual(observations[1], observations[0]);
  });
}

test("worker metadata mismatch fails before source preparation or backend submission", async (t) => {
  const f = await fixture(t),
    request = current.fromParsedCommand(f.command);
  for (const api of [previous, current])
    await assert.rejects(
      api.execute(
        { ...request, argv: ["run", "another.py"] },
        {
          async callTool() {
            assert.fail("No backend call");
          },
        },
      ),
      (error) => {
        assert.ok(error instanceof Error && "code" in error);
        assert.equal(error.code, "INVALID_REQUEST");
        return true;
      },
    );
  assert.equal(await fs.readFile(f.file, "utf8"), f.source);
});

test("missing backend and non-Error failures have actionable diagnostics without retry", async (t) => {
  const f = await fixture(t),
    request = current.fromParsedCommand(f.command);
  await assert.rejects(
    previous.execute(request, null, undefined, streams().io),
    /server/,
  );
  await assert.rejects(
    current.execute(request, null, undefined, streams().io),
    /Run command requires a backend/,
  );
  for (const api of [previous, current]) {
    let calls = 0;
    const output = streams();
    const code = await api.execute(
      request,
      {
        async callTool() {
          calls++;
          throw "unconfirmed native result";
        },
      },
      undefined,
      output.io,
    );
    assert.equal(code, 1);
    assert.equal(calls, 1);
    assert.equal(
      output.output().stderr,
      api === previous
        ? "ERROR undefined\n"
        : "ERROR unconfirmed native result\n",
    );
  }
});

test("invocation storage keeps overlapping owners separate and shares one runtime instance", async () => {
  const staged = load(
    "./src/dist/node-adapters/execution/invocation.js",
  ) as Invocation;
  assert.equal(invocation.context, staged.context);
  for (const api of [oldInvocation, invocation]) {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = api.context.run(
      { description: "A", sourcePath: "A.py" },
      async () => {
        await barrier;
        return structuredClone(api.context.getStore());
      },
    );
    const second = api.context.run(
      { description: "B", sourcePath: "B.py" },
      async () => {
        release();
        await Promise.resolve();
        return structuredClone(api.context.getStore());
      },
    );
    assert.deepEqual(await Promise.all([first, second]), [
      { description: "A", sourcePath: "A.py" },
      { description: "B", sourcePath: "B.py" },
    ]);
    assert.equal(api.context.getStore(), undefined);
  }
});
