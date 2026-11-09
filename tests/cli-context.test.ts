import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  FmcadServices,
  FmcadOptions,
  CadWorkerInvocation,
} from "../src/api";
const load = createRequire(__filename);
const { main } = load(
  path.join(process.cwd(), "src/cli"),
) as typeof import("../src/entrypoints/cli");

test("CLI preserves document display names without treating them as durable identities", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-document-context-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "context.py");
  fs.writeFileSync(
    script,
    'ARGS = {}\nDOC_NAME = ""\ndef run(context):\n    pass\n',
  );
  const name = 'Review "Model"\n\\test';
  for (const args of [
    ["document", "status", "--data", "{}"],
    ["run", script],
  ]) {
    for (const identity of [
      [],
      ["--doc-id", "creation-id"],
      ["--doc-file-id", "file-id"],
    ]) {
      let context: FmcadOptions["context"] | undefined;
      let payload: CadWorkerInvocation | undefined;
      let stderr = "";
      const code = await main([...args, "--doc", name, ...identity], {
        loadConfig: () => ({
          cfg: {
            backend: "mcp",
            routing: "queue",
            url: "http://host",
            headers: {},
            timeoutMs: 1000,
            tool: "execute_python",
            transport: "node",
            protocolVersion: "2025-06-18",
            queue: { autoStart: false },
            controlCenter: { port: 4748 },
          },
        }),
        createFmcad(options) {
          context = options.context;
          const service: Partial<FmcadServices> = {
            async start() {},
            async dispose() {},
            async execute(input) {
              payload = input;
              return {
                version: 1,
                requestId: "context-test",
                jobId: null,
                state: "succeeded",
                result: null,
                outcome: {
                  version: 1,
                  requestId: null,
                  jobId: null,
                  acceptance: "accepted",
                  executionOutcome: "succeeded",
                  mayHaveMutated: null,
                  code: null,
                  validation: {
                    status: "not_checked",
                    source: null,
                    artifactId: null,
                    measurements: {},
                  },
                },
              };
            },
          };
          return new Proxy(service, {
            get(target, key) {
              assert(
                Reflect.has(target, key),
                `Unexpected service access: ${String(key)}`,
              );
              return Reflect.get(target, key);
            },
          }) as FmcadServices;
        },
        stdout: { write() {} },
        stderr: {
          write(text) {
            stderr += text;
          },
        },
        setExitCode() {},
      });
      assert.equal(code, 0, stderr);
      assert(context);
      assert.equal(context.documentId, identity[1]);
      assert(payload);
      assert.equal(
        payload.kind === "run"
          ? payload.request.doc
          : payload.kind === "cad-command"
            ? payload.invocation.doc
            : payload.doc,
        name,
      );
    }
  }
});

test("completed local previews retain unresolved evidence without weakening ordinary or native exit policy", () => {
  const { receiptExitCode } = load(
    path.join(process.cwd(), "src/dist/entrypoints/cli/application"),
  ) as typeof import("../src/entrypoints/cli/application");
  const value: import("../src/api").ExecutionReceipt = {
    version: 1,
    requestId: "preview-test",
    jobId: null,
    state: "local",
    result: {
      success: true,
      status: "unknown",
      mutation: false,
      modelValidated: false,
    },
    outcome: {
      version: 1,
      requestId: null,
      jobId: null,
      acceptance: "accepted",
      executionOutcome: "unknown",
      mayHaveMutated: null,
      code: null,
      validation: {
        status: "not_checked",
        source: null,
        artifactId: null,
        measurements: {},
      },
    },
  };
  assert.equal(receiptExitCode(value, "catalog.import", true), 0);
  assert.equal(receiptExitCode(value, "catalog.import"), 1);
  assert.equal(
    receiptExitCode({ ...value, state: "succeeded" }, "catalog.import", true),
    1,
  );
  for (const result of [
    { success: false, status: "unknown" },
    { success: true, status: "failed" },
    { success: true, outcome: "unknown" },
  ])
    assert.equal(
      receiptExitCode({ ...value, result }, "catalog.import", true),
      1,
    );
});
