import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
interface LegacyHelpers {
  ok(result: unknown): void;
}
const load = createRequire(path.join(process.cwd(), "tests/param-add.test.ts"));
const { buildOpScript } = load(
  "../src/ops",
) as typeof import("../packages/node-adapters/src/python/legacy-operations");
const { ok } = load("./helpers/legacy") as LegacyHelpers;

// Execute the shipped Python dispatcher and handler with only Fusion services mocked.
const instrument = `
import contextlib, io, json, sys, types
payload = json.load(sys.stdin)
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
adsk.core.Application = types.SimpleNamespace(get=lambda: types.SimpleNamespace(data=None))
adsk.core.ValueInput = types.SimpleNamespace(createByString=lambda expression: expression)
ns = {}
exec(payload['script'], ns)
received = []
created = []
documents = []
class Parameters(list):
    def add(self, name, expression, unit, comment):
        created.append([name, expression, unit, comment])
        return types.SimpleNamespace(name=name, expression=expression, unit=unit, comment=comment)
design = types.SimpleNamespace(userParameters=Parameters([types.SimpleNamespace(name='width', unit='mm')]))
def target(doc):
    documents.append(doc)
    return design
ns['_design'] = target
handler = ns['cmd_param_add']
def record(data, *args):
    received.append(list(args))
    handler(data, *args)
ns['cmd_param_add'] = record
with contextlib.redirect_stdout(io.StringIO()) as output:
    ns['run']('')
print(json.dumps(dict(args=ns['ARGS'], received=received, documents=documents, created=created, output=output.getvalue())))
`;

function execute(script: string) {
  const result = spawnSync("python3", ["-B", "-c", instrument], {
    input: JSON.stringify({ script }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as {
    args: unknown;
    received: unknown;
    documents: unknown;
    created: unknown;
    output: string;
  };
}

async function fixture() {
  const { resolveFmcadConfiguration } = load(
    "../packages/core/dist/domain/config",
  );
  const config = resolveFmcadConfiguration({
    adapter: {},
    environment: {},
    file: {
      backend: "addin",
      routing: "queue",
      backends: {
        addin: {
          url: "http://127.0.0.1:8765/mcp",
          tool: "fusion_mcp_execute",
          transport: "node",
        },
      },
    },
    platformDefaults: {},
    acceptedService: null,
  });
  const requests: { action: string; request: { backend: string } }[] = [];
  const calls: {
    name: string;
    arguments: { featureType: string; object: { script: string } };
  }[] = [];
  async function run(words: string[]) {
    let stdout = "";
    let stderr = "";
    const argv = ["--backend", "addin", ...words];
    const dependencies = {
      stdout: {
        write(value: unknown) {
          stdout += String(value);
        },
      },
      stderr: {
        write(value: unknown) {
          stderr += String(value);
        },
      },
      setExitCode() {},
      loadConfig: () => ({ cfg: config }),
      async runQueued(
        rawArgv: string[],
        selectedConfig: {
          backend: string;
          timeoutMs: number;
          [key: string]: unknown;
        },
      ) {
        const { prepareRequest } = load("../src/composition/execution-request");
        const request = {
          requestId: randomUUID(),
          kind: "command",
          argv: rawArgv,
          cwd: process.cwd(),
          timeoutMs: selectedConfig.timeoutMs,
          backend: selectedConfig.backend,
          buildHash: "param-add-fixture",
        };
        requests.push({ action: "submit", request });
        const backend = {
          boundary: "fmcad-broker",
          server: selectedConfig,
          capabilities: {
            backend: selectedConfig.backend,
            automaticFallback: false,
            readOnlyEnforced: false,
          },
          async callTool(
            argumentsValue: {
              featureType: string;
              object: { script: string };
            },
            name = "fusion_mcp_execute",
          ) {
            calls.push({ name, arguments: argumentsValue });
            return { text: "DONE", failed: false };
          },
        };
        const originalOut = process.stdout.write;
        const originalErr = process.stderr.write;
        process.stdout.write = (value) => {
          stdout += String(value);
          return true;
        };
        process.stderr.write = (value) => {
          stderr += String(value);
          return true;
        };
        try {
          return await load("../src/composition/legacy-worker").execute(
            prepareRequest({ request }),
            backend,
            () => {},
          );
        } finally {
          process.stdout.write = originalOut;
          process.stderr.write = originalErr;
        }
      },
    };
    const code = await load("../src/cli").main(argv, dependencies);
    return { code, signal: null, stdout, stderr };
  }

  return { requests, calls: () => calls, run };
}

const doc = "RF_Ownership_20260910_01 v2";
const cases = [
  { args: ["height", "width * 2"], unit: "mm", comment: "" },
  { args: ["depth", "10 mm"], unit: "mm", comment: "" },
  { args: ["count", "2"], unit: "", comment: "" },
  { args: ["angle", "45 deg", "deg"], unit: "deg", comment: "" },
  { args: ["height", "width * 2", ""], unit: "mm", comment: "" },
  {
    args: ["depth", "10 mm", "cm", 'outer "depth"'],
    unit: "cm",
    comment: 'outer "depth"',
  },
  {
    args: ["depth", "10 mm", "", "outer depth"],
    unit: "mm",
    comment: "outer depth",
  },
  { args: ["depth", "10 mm", "", ""], unit: "mm", comment: "" },
];

for (const { args, unit, comment } of cases) {
  test(`param_add CLI dispatch and Python target ${JSON.stringify(args)}`, async () => {
    const expected = [args[0], args[1], args[2] ?? "", args[3] ?? "", doc];
    const h = await fixture();
    ok(await h.run(["--backend", "addin", "param_add", ...args, "--doc", doc]));
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0]!.action, "submit");
    assert.equal(h.requests[0]!.request.backend, "addin");
    const dispatched = h
      .calls()
      .filter((call) => call.name === "fusion_mcp_execute");
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0]!.arguments.featureType, "script");
    const result = execute(dispatched[0]!.arguments.object.script);
    assert.deepEqual(result.args, expected);
    assert.deepEqual(result.received, [expected]);
    assert.deepEqual(result.documents, [doc]);
    assert.deepEqual(result.created, [[args[0], args[1], unit, comment]]);
    assert.match(result.output, /CREATED_PARAM .*\nDONE\n/);
  });
}

test("param_add generic builder preserves raw Python optional positional semantics", () => {
  for (const args of [
    ["depth", "10 mm"],
    ["depth", "10 mm", "mm"],
    ["depth", "10 mm", "mm", "note"],
  ]) {
    const result = execute(buildOpScript("param_add", args));
    assert.deepEqual(result.args, args);
    assert.deepEqual(result.received, [
      [args[0], args[1], args[2] ?? "", args[3] ?? "", ""],
    ]);
    assert.deepEqual(result.documents, [""]);
  }
});
