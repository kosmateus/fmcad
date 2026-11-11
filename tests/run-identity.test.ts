import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import type { FmcadServices } from "../src/api";
const load = createRequire(__filename),
  root = process.cwd();
const { main } = load(
  path.join(root, "src/cli"),
) as typeof import("../src/entrypoints/cli");
const { buildRunScript, formatRunOutput } = load(
  path.join(root, "src/run"),
) as typeof import("../src/composition/run");
const { publishComplete } = load(
  path.join(root, "src/publish"),
) as typeof import("../packages/node-adapters/src/persistence/publish");
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
interface Request {
  script: string;
  scenario?: string;
}
type Case = [Request, string[], RegExp?];
interface Result {
  error: string | null;
  text: string;
  loadedEvents: unknown[];
  events: unknown[];
}

const pins = { docId: "creation-original", docFileId: "urn:cloud:original" };
const source = `from __future__ import annotations
import json
import run_probe
ARGS = []
DOC_NAME = ''
run_probe.events.append('top:' + run_probe.app.activeDocument.name)
def run(context: UndefinedAnnotation):
    run_probe.events.append('run:' + run_probe.app.activeDocument.name)
    print('FMCAD_RESULT ' + json.dumps({'args': ARGS, 'doc': DOC_NAME, 'context': context}, ensure_ascii=False))
`;

async function fixture(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "run-identity-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "trusted.py");
  await fs.writeFile(file, source);
  return { dir, file };
}

function execute(requests: Request[]): Result[] {
  const result = spawnSync(
    "python3",
    ["-B", path.join(root, "tests/run_identity_fixture.py")],
    {
      input: JSON.stringify(requests),
      encoding: "utf8",
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const values: unknown = JSON.parse(result.stdout);
  assert(Array.isArray(values));
  return values.map((value: unknown) => {
    assert(value !== null && typeof value === "object");
    const item = value as Record<string, unknown>;
    assert(item["error"] === null || typeof item["error"] === "string");
    assert.equal(typeof item["text"], "string");
    assert(Array.isArray(item["loadedEvents"]));
    assert(Array.isArray(item["events"]));
    return {
      error: item["error"],
      text: item["text"] as string,
      loadedEvents: item["loadedEvents"],
      events: item["events"],
    };
  });
}

test("run pins reject invalid values, duplicates, absent doc and listing before backend", async () => {
  const cases = [];
  for (const flag of ["--doc-id", "--doc-file-id"]) {
    for (const args of [
      [flag],
      [flag, ""],
      [flag, " "],
      [flag, "a b"],
      [flag, "a\nb"],
      [flag, "-1"],
      [flag, "--readonly"],
      [flag, "x", flag, "x"],
      [flag, "x", flag, "y"],
    ]) {
      cases.push(["missing.py", "--doc", "Model", ...args]);
    }
    cases.push(
      ["missing.py", flag, "x"],
      ["missing.py", "--doc", " ", flag, "x"],
      ["--list", "--doc", "Model", flag, "x"],
      ["-l", "--doc", "Model", flag, "x"],
    );
  }
  for (const args of cases) {
    let backend = 0,
      error = "";
    const code = await main(["run", ...args], {
      loadConfig() {
        backend++;
        throw new Error("backend reached");
      },
      stdout: { write() {} },
      stderr: {
        write(s) {
          error += s;
        },
      },
      setExitCode() {},
    });
    assert.equal(code, 1, JSON.stringify(args));
    assert.equal(backend, 0);
    assert.match(
      error,
      /missing value|requires|require --doc|Duplicate|cannot be combined/,
    );
  }
});

test("actual invocation guards precede all user code and share exact CAD target policy", async (t) => {
  const { file } = await fixture(t);
  const build = (identity: Parameters<typeof buildRunScript>[4]) =>
    buildRunScript(file, null, true, "Módèl", identity);
  const mutation = build(pins);
  const cases: Case[] = [
    [{ script: mutation }, ["activate", "top:Módèl", "run:Módèl"]],
    [
      { script: mutation, scenario: "already-active" },
      ["top:Módèl", "run:Módèl"],
    ],
    [
      { script: build({ ...pins, readOnly: true }) },
      ["top:Other", "run:Other"],
    ],
    [
      { script: build({ docId: pins.docId }), scenario: "unsaved" },
      ["activate", "top:Módèl", "run:Módèl"],
    ],
    [
      { script: build({ docFileId: pins.docFileId }) },
      ["activate", "top:Módèl", "run:Módèl"],
    ],
    ...[
      "missing",
      "duplicate",
      "unsaved",
      "stale-cloud",
      "late-replacement",
    ].map((scenario): Case => [
      { script: mutation, scenario },
      [],
      /expected one match|mismatch/,
    ]),
    ...["false-activation", "no-switch", "activation-transition"].map(
      (scenario): Case => [
        { script: mutation, scenario },
        ["activate"],
        /activation failed|does not match|mismatch/,
      ],
    ),
    [{ script: build({ docId: "other", readOnly: true }) }, [], /mismatch/],
    [
      { script: build({ docFileId: "other-file", readOnly: true }) },
      [],
      /mismatch/,
    ],
  ];
  const results = execute(cases.map(([request]) => request));
  results.forEach((result, i) => {
    const entry = cases[i];
    assert(entry);
    const [request, events, error] = entry;
    assert.deepEqual(result.loadedEvents, [], JSON.stringify(request.scenario));
    assert.deepEqual(result.events, events);
    if (error) {
      assert.equal(typeof result.error, "string");
      assert.match(result.error!, error);
    } else {
      assert(result);
      assert.equal(result.error, null);
      assert.deepEqual(JSON.parse(result.text.slice("FMCAD_RESULT ".length)), {
        args: null,
        doc: "Módèl",
        context: "context-✓",
      });
    }
  });
});

test("guarded top-level-only script executes once; unguarded source remains legacy", async (t) => {
  const { file } = await fixture(t);
  assert.equal(buildRunScript(file, [], false, ""), source);
  await fs.writeFile(
    file,
    `from __future__ import annotations
DOC_NAME = ''
import run_probe
run_probe.events.append('top-only')
`,
  );
  const [result] = execute([
    { script: buildRunScript(file, [], false, "Módèl", pins) },
  ]);
  assert(result);
  assert.equal(result.error, null);
  assert.deepEqual(result.loadedEvents, []);
  assert.deepEqual(result.events, ["activate", "top-only"]);
  await fs.writeFile(file, 'print("no slots")');
  assert.throws(
    () => buildRunScript(file, [], false, "Módèl", pins),
    /DOC_NAME/,
  );
  assert.throws(() => buildRunScript(file, null, true, "", {}), /ARGS/);
});

test("guarded CLI preserves args-file, Unicode, output text/json and never retries", async (t) => {
  const { dir, file } = await fixture(t);
  const argsFile = path.join(dir, "args.json");
  const args = { text: "Zażółć 🧪 $&", value: null, yes: true };
  await fs.writeFile(argsFile, JSON.stringify(args));
  for (const mode of ["text", "json", "backend-failure", "bad-json"]) {
    const out = path.join(dir, mode);
    let calls = 0,
      stdout = "",
      stderr = "",
      backendText = "";
    const format = mode === "text" ? "text" : "json";
    const code = await main(
      [
        "run",
        file,
        "--doc",
        "Módèl",
        "--doc-id",
        pins.docId,
        "--doc-file-id",
        pins.docFileId,
        "--args-file",
        argsFile,
        "--readonly",
        "--out",
        out,
        "--out-format",
        format,
        ...(format === "json" ? ["--pretty", "true"] : []),
      ],
      {
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
        createFmcad: () =>
          partial<FmcadServices>({
            async start() {},
            async dispose() {},
            async execute(payload, options) {
              calls++;
              assert.equal(payload.kind, "run");
              assert(payload.kind === "run");
              assert.equal(payload.request.identity.readOnly, true);
              assert.equal(payload.request.doc, "Módèl");
              assert.deepEqual(payload.request.identity, {
                docId: pins.docId,
                docFileId: pins.docFileId,
                readOnly: true,
              });
              assert.deepEqual(payload.request.args, args);
              assert.equal(options.inputFiles?.[0]?.path, argsFile);
              backendText =
                mode === "bad-json"
                  ? "not JSON"
                  : `FMCAD_RESULT ${JSON.stringify({ args, doc: "Módèl", context: "context-✓" })}`;
              let failed = mode === "backend-failure";
              let workerStderr = "";
              if (!failed && payload.output?.path) {
                try {
                  const formatted = formatRunOutput(
                    backendText,
                    payload.output.format,
                    payload.output.pretty,
                  );
                  await publishComplete(payload.output.path, formatted);
                } catch (error) {
                  assert(error instanceof Error);
                  failed = true;
                  workerStderr = `ERROR ${error.message}. Script may have mutated Fusion; inspect before another run. No automatic retry.\n`;
                }
              }
              return {
                version: 1,
                requestId: options.requestId,
                jobId: "job",
                state: failed ? "failed" : "succeeded",
                result: null,
                output: { stdout: backendText, stderr: workerStderr },
                outcome: {
                  version: 1,
                  requestId: null,
                  jobId: null,
                  acceptance: "accepted",
                  executionOutcome: failed ? "failed" : "succeeded",
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
            },
          }),
        stdout: {
          write(s) {
            stdout += s;
          },
        },
        stderr: {
          write(s) {
            stderr += s;
          },
        },
        setExitCode() {},
      },
    );
    assert.equal(calls, 1);
    assert.equal(stdout, backendText);
    if (["text", "json"].includes(mode)) {
      assert.equal(code, 0, stderr);
      const saved = await fs.readFile(out, "utf8");
      if (mode === "text") assert.equal(saved, backendText);
      else
        assert.equal(
          saved,
          JSON.stringify(
            JSON.parse(backendText.slice("FMCAD_RESULT ".length)),
            null,
            2,
          ) + "\n",
        );
    } else {
      assert.equal(code, 1);
      await assert.rejects(fs.stat(out), { code: "ENOENT" });
    }
  }
});
