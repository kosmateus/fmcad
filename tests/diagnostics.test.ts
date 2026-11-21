import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type {
  FmcadServices,
  FmcadConfiguration,
  ExecutionReceipt,
} from "../src/api";
import type { CommandBackend } from "../src/composition/cad-service";
const load = createRequire(__filename),
  root = process.cwd();
const { redactDiagnostic } = load(
  path.join(root, "src/diagnostics"),
) as typeof import("../packages/core/src/domain/diagnostics");
const { main } = load(
  path.join(root, "src/cli"),
) as typeof import("../src/entrypoints/cli");
const cad = load(
  path.join(root, "src/cad-service"),
) as typeof import("../src/composition/cad-service");
function partial<T extends object>(value: Partial<T>): T {
  return new Proxy(value, {
    get(target, key) {
      assert(
        Reflect.has(target, key),
        `Unexpected service access: ${String(key)}`,
      );
      return Reflect.get(target, key);
    },
  }) as T;
}
function config(url = "http://host"): FmcadConfiguration {
  return {
    backend: "mcp",
    routing: "queue",
    url,
    headers: { "X-Credential": "known-secret" },
    queue: { autoStart: false },
    controlCenter: { port: 4748 },
    timeoutMs: 1000,
    tool: "execute_python",
    transport: "node",
    protocolVersion: "2025-06-18",
  };
}
function script(t: import("node:test").TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-run-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "synthetic.py");
  fs.writeFileSync(
    file,
    'ARGS = {}\nDOC_NAME = ""\ndef run(context):\n    pass\n',
  );
  return file;
}
function receipt(
  code: number,
  stdout: string,
  stderr: string,
): ExecutionReceipt {
  return {
    version: 1,
    requestId: "diagnostic-test",
    jobId: null,
    state: code ? "failed" : "succeeded",
    result: null,
    output: { stdout, stderr },
    outcome: {
      version: 1,
      requestId: null,
      jobId: null,
      acceptance: "accepted",
      executionOutcome: code ? "failed" : "succeeded",
      mayHaveMutated: null,
      validation: {
        status: "not_checked",
        source: null,
        artifactId: null,
        measurements: {},
      },
      code: null,
    },
  };
}

test("diagnostic redaction knows configured credentials, preserves CAD identifiers and JSON", () => {
  const backend = {
    url: "https://user:password@host/mcp?custom=private",
    headers: { "X-Custom-Auth": "custom-secret", Host: "host" },
  };
  const text = redactDiagnostic(
    JSON.stringify({
      Authorization: "Bearer auth-secret",
      message: `${backend.url} custom-secret https://a:b@host/?api_key=url-secret&doc=123`,
      entityToken: "CAD-token",
      token: "CAD-token",
      ref: "?token=CAD-token",
      host: "host",
    }),
    backend,
  );
  for (const secret of [
    "auth-secret",
    "custom-secret",
    "url-secret",
    "private",
    "password",
  ])
    assert.ok(!text.includes(secret), text);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.equal(parsed["entityToken"], "CAD-token");
  assert.equal(parsed["ref"], "?token=CAD-token");
  assert.equal(parsed["host"], "host");
  assert.equal(
    JSON.parse(
      redactDiagnostic(
        JSON.stringify({ message: "Authorization: Bearer hidden-secret" }),
      ),
    ).message,
    "Authorization: [REDACTED]",
  );
  assert.ok(
    !redactDiagnostic("https://host/#access_token=fragment-secret").includes(
      "fragment-secret",
    ),
  );
});

test("recognized JSON credentials redact escaped and incomplete values, not CAD tokens/signatures", () => {
  const value = Object.fromEntries(
    [
      "access_token",
      "refresh_token",
      "client_secret",
      "password",
      "api_key",
      "secret",
    ].map((name) => [name, 'private-"escaped']),
  );
  Object.assign(value, {
    token: "CAD-token",
    entityToken: "CAD-entity",
    signature: "CAD-signature",
  });
  const text = redactDiagnostic(JSON.stringify(value));
  assert.ok(!text.includes("private-"));
  const parsed = JSON.parse(text) as Record<string, unknown>;
  for (const name of ["token", "entityToken", "signature"])
    assert.equal(parsed[name], value[name]);
  assert.ok(
    !redactDiagnostic('{"secret":"unfinished-private').includes(
      "unfinished-private",
    ),
  );
});

test("pretty JSON scalar credentials keep commas and ordinary CAD fields", () => {
  for (const value of ['"sëcret,with,commas"', "123.5", "null"]) {
    for (const separator of [" ", "\n    ", "\n\n    "]) {
      const source =
        '{\n  "password":' +
        separator +
        value +
        ",\n" +
        '  "value": "ordinary",\n  "token": "CAD-token",\n' +
        '  "entityToken": "CAD-entity"\n}\n';
      const text = redactDiagnostic(source);
      assert.deepEqual(JSON.parse(text), {
        password: "[REDACTED]",
        value: "ordinary",
        token: "CAD-token",
        entityToken: "CAD-entity",
      });
      assert.ok(!text.includes("sëcret"));
    }
  }
});

test("raw Cookie Authorization and secret headers redact comma suffixes and folded values", () => {
  for (const name of ["Cookie", "Authorization", "secret"]) {
    for (const separator of [" ", "\n  ", "\n"]) {
      const source =
        name +
        ":" +
        separator +
        "first-private, suffix-private\n" +
        "\tfolded-private, folded-suffix\nordinary evidence\n";
      const text = redactDiagnostic(source);
      for (const secret of [
        "first-private",
        "suffix-private",
        "folded-private",
        "folded-suffix",
      ]) {
        assert.ok(!text.includes(secret), text);
      }
      assert.ok(text.includes("ordinary evidence"));
    }
  }
});

test("CLI redacts stderr using injected backend config without changing run stdout", async (t) => {
  let stdout = "",
    stderr = "";
  const payload =
    "Authorization: Bearer execution-output entityToken=CAD-token";
  const cfg = config();
  let executed = false,
    disposed = false;
  const code = await main(["run", script(t)], {
    loadConfig: () => ({ cfg }),
    createFmcad: () =>
      partial<FmcadServices>({
        async start() {},
        async dispose() {
          disposed = true;
        },
        async execute(input) {
          executed = true;
          let out = "",
            err = "";
          const code = await cad.execute(
            { payload: input },
            partial<CommandBackend>({
              server: cfg,
              capabilities: { backend: "mcp" },
              async callTool() {
                return {
                  text: payload,
                  stderr: "known-secret Authorization: Bearer hidden-secret\n",
                  failed: false,
                };
              },
            }),
            () => {},
            {
              stdout: {
                write: (text) => {
                  out += text;
                },
              },
              stderr: {
                write: (text) => {
                  err += text;
                },
              },
            },
          );
          return receipt(code, out, err);
        },
      }),
    stdout: {
      write: (text) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
    setExitCode: () => {},
  });
  assert.equal(code, 0, stderr);
  assert(executed);
  assert(disposed);
  assert.equal(stdout, payload + "\n");
  assert.ok(!stderr.includes("known-secret"));
  assert.ok(!stderr.includes("hidden-secret"));
});

test("CLI thrown backend diagnostics use known URL/header redaction", async (t) => {
  let stderr = "";
  const url = "https://host/private-path?custom=private-query";
  const code = await main(["run", script(t)], {
    loadConfig: () => ({ cfg: config(url) }),
    createFmcad: () =>
      partial<FmcadServices>({
        async start() {},
        async dispose() {},
        async execute() {
          throw new Error(`primary failure ${url} known-secret`);
        },
      }),
    stdout: {
      write() {
        assert.fail("No execution result");
      },
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
    setExitCode: () => {},
  });
  assert.equal(code, 1);
  assert.match(stderr, /primary failure/);
  for (const secret of ["known-secret", "private-path", "private-query"])
    assert.ok(!stderr.includes(secret), stderr);
});

test("doctor shows only the origin and hides all potentially credential-bearing endpoint details", async () => {
  let stdout = "";
  const code = await main(["doctor"], {
    loadConfig: () => ({
      cfg: config(
        "https://user:private-password@host/private-path?access_token=private-token&custom=private-custom#private-fragment",
      ),
    }),
    // Doctor is a retained worker formatter, dispatched through runQueued.
    async runQueued(argv, cfg) {
      assert.deepEqual(argv, ["doctor"]);
      const worker = load(path.join(root, "src/composition/legacy-worker")) as {
        execute(
          request: {
            payload: {
              entry: { kind: "doctor" };
              args: string[];
              flags: Record<string, never>;
              options: Record<string, never>;
            };
          },
          client: { server: FmcadConfiguration; listTools(): Promise<[]> },
          onOutcome: () => void,
        ): Promise<number>;
      };
      const write = process.stdout.write;
      process.stdout.write = ((text: string | Uint8Array) => {
        stdout +=
          typeof text === "string" ? text : Buffer.from(text).toString();
        return true;
      }) as typeof write;
      try {
        return await worker.execute(
          {
            payload: {
              entry: { kind: "doctor" },
              args: [],
              flags: {},
              options: {},
            },
          },
          {
            server: cfg,
            async listTools() {
              return [];
            },
          },
          () => {},
        );
      } finally {
        process.stdout.write = write;
      }
    },
    stdout: {
      write: (text) => {
        stdout += text;
      },
    },
    stderr: { write: (text) => assert.fail(text) },
    setExitCode: () => {},
  });
  assert.equal(code, 0);
  assert.ok(stdout.includes("https://host/"));
  for (const secret of [
    "private-password",
    "private-token",
    "private-path",
    "private-custom",
    "private-fragment",
  ])
    assert.ok(!stdout.includes(secret));
  assert.ok(
    !redactDiagnostic("Mcp-Session-Id: private-session").includes(
      "private-session",
    ),
  );
});
