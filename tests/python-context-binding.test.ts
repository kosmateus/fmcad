import {
  present,
  mutableManifest,
  diagnostics,
  retainedOrigin,
  type MutableManifest,
} from "./python-test-contracts";
import { createRequire } from "node:module";
import type { PreparedPythonArtifact } from "@fmcad/core";
import type { SourceInput } from "../packages/node-adapters/src/python/artifact";
import { record, at } from "./integration/offline-cli";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const repository = path.resolve(__dirname, "../..");
const load = createRequire(
  path.join(repository, "tests", "python-context-binding.test.js"),
);
const {
  preparePythonArtifact,
  pythonArtifactManifest,
  bindPythonArtifactManifest,
  retainPythonOrigin,
  pythonUnitContexts,
  createPythonChecker,
  createPythonRpcAdmission,
} = load(
  "../src/python",
) as typeof import("../packages/node-adapters/src/python/artifact") &
  typeof import("../packages/node-adapters/src/python/context-binding") &
  typeof import("../packages/node-adapters/src/python/checker") &
  typeof import("../packages/node-adapters/src/python/admission");
const { prepareReceiptScript } = load("../src/queue-instance") as ReturnType<
  typeof import("../packages/node-adapters/src/execution/queue-instance").createQueueInstance
>;
const { createBrokerTransport } = load(
  "../src/dist/fusion-transport/broker",
) as typeof import("../packages/node-adapters/src/fusion-transport/broker");
const runtime = path.resolve("dist/runtime/python");
const official = (script: string) => ({
  method: "tools/call",
  params: {
    name: "fusion_mcp_execute",
    arguments: { featureType: "script", object: { script } },
  },
});
const admission = () =>
  createPythonRpcAdmission({
    runtime,
    checker: createPythonChecker({
      typingRoot: path.join(runtime, "typing"),
      definitionsRoot: path.join(runtime, "typing"),
      pythonPlatform: "Windows",
    }),
  });

function original(extra: SourceInput[] = []) {
  const source = 'app.userInterface.messageBox("checked")';
  // This wrapper really supplies app to that isolated exec namespace. There is
  // no inferred global based on the word "bundle" or on a filename alone.
  const wrapper =
    'import adsk.core\n_namespace: dict[str, object] = {"app": adsk.core.Application.get()}\n' +
    `exec(compile(${JSON.stringify(source)}, "caller.py", "exec"), _namespace)\n` +
    "def run(context: str) -> None:\n    pass";
  return preparePythonArtifact(
    [
      {
        id: "user",
        filename: "caller.py",
        source,
        role: "user",
        embedded: true,
      },
      ...extra,
      {
        id: "runtime",
        filename: "builder.py",
        source: wrapper,
        role: "wrapper",
      },
    ],
    {
      context: { unitContexts: { user: { kind: "bundle", app: true } } },
      request: { operation: "fixture" },
    },
  );
}
function receipt(source: PreparedPythonArtifact) {
  const manifest = bindPythonArtifactManifest(
    source.script,
    pythonArtifactManifest(source),
  );
  const final = prepareReceiptScript(
    source.script,
    true,
    "/offline/never.json",
    { jobId: "fixture" },
    { mapPath: (p) => p },
  );
  return retainPythonOrigin(final, manifest);
}

test("private manifest binds all original source metadata without sending a duplicate byte array", () => {
  const artifact = original();
  const manifest = pythonArtifactManifest(artifact);
  assert.equal(record(manifest)["script"], undefined);
  assert.equal(record(manifest)["bytes"], undefined);
  assert.equal(
    bindPythonArtifactManifest(artifact.script, manifest).artifactHash,
    artifact.artifactHash,
  );
  assert.throws(
    () => bindPythonArtifactManifest(artifact.script + "\npass", manifest),
    { code: "PYTHON_CONTEXT_CHANGED" },
  );
  for (const change of [
    (m: MutableManifest) => (present(m.units[0])["source"] += "\nx: str = 1"),
    (m: MutableManifest) => (m.context = {}),
    (m: MutableManifest) => (m.sourceMap = []),
  ]) {
    const tampered = mutableManifest(manifest);
    change(tampered);
    assert.throws(() => bindPythonArtifactManifest(artifact.script, tampered), {
      code: "PYTHON_CONTEXT_CHANGED",
    });
  }
  const final = receipt(artifact);
  assert.equal(retainedOrigin(final).artifactHash, artifact.artifactHash);
  assert.equal(retainedOrigin(final).sha256, artifact.sha256);
  const user = final.units.find((unit) => unit.filename === "caller.py");
  assert.equal(present(pythonUnitContexts(final)[present(user).id]).app, true);
  assert.ok(Object.isFrozen(pythonUnitContexts(final)[present(user).id]));
  assert.throws(
    () =>
      retainPythonOrigin(
        prepareReceiptScript(
          "def run(context: str) -> None:\n    pass",
          true,
          "/offline/never.json",
          { jobId: "other" },
          { mapPath: (p) => p },
        ),
        manifest,
      ),
    { code: "PYTHON_CONTEXT_CHANGED" },
  );
});

test("special source-unit identifiers remain own context properties and are included in provenance JSON", () => {
  const artifact = preparePythonArtifact(
    [
      {
        id: "__proto__",
        filename: "special.py",
        role: "wrapper",
        source: "def run(context: str) -> None:\n    pass",
      },
    ],
    { context: { entrypoints: ["special.py"] } },
  );
  const contexts = pythonUnitContexts(artifact);
  assert.equal(Object.getPrototypeOf(contexts), null);
  assert.ok(Object.hasOwn(contexts, "__proto__"));
  assert.equal(
    JSON.parse(JSON.stringify(contexts)).__proto__.entrypoint,
    "run",
  );
});

test("real checker honors only the matching embedded namespace and still checks unused declared source", async () => {
  const checked = admission(),
    final = receipt(original());
  assert.equal(
    present((await checked.check(official(final.script), final)).report).status,
    "passed",
  );
  const withoutOrigin = prepareReceiptScript(
    original().script,
    true,
    "/offline/never.json",
    { jobId: "without-context" },
    { mapPath: (p) => p },
  );
  await assert.rejects(
    checked.check(official(withoutOrigin.script), withoutOrigin),
    (error) =>
      record(error)["code"] === "PYTHON_CHECK_REJECTED" &&
      diagnostics(error).some(
        (d) =>
          d["filename"] === "caller.py" &&
          d["rule"] === "reportUndefinedVariable",
      ),
  );
  const unused = receipt(
    original([
      {
        id: "unused",
        filename: "unused.py",
        source: 'value: int = "bad"',
        role: "user",
        embedded: true,
      },
    ]),
  );
  assert.ok(unused.units.some((unit) => unit.filename === "unused.py"));
  await assert.rejects(
    checked.check(official(unused.script), unused),
    (error) =>
      record(error)["code"] === "PYTHON_CHECK_REJECTED" &&
      diagnostics(error).some(
        (d) =>
          d["filename"] === "unused.py" && d["rule"] === "reportAssignmentType",
      ),
  );
  const namedSource = 'def run(context: str) -> None:\n    value: int = "bad"';
  const named = preparePythonArtifact([
    {
      id: "named-user",
      filename: "/project/original.py",
      source: namedSource,
      role: "user",
    },
    {
      id: "duplicate",
      filename: "duplicate.py",
      source: namedSource,
      role: "user",
      embedded: true,
    },
  ]);
  const namedReceipt = receipt(named);
  await assert.rejects(
    checked.check(official(namedReceipt.script), namedReceipt),
    (error) =>
      ["/project/original.py", "duplicate.py"].every((filename) =>
        diagnostics(error).some(
          (d) =>
            d["filename"] === filename &&
            d["line"] === 2 &&
            d["rule"] === "reportAssignmentType",
        ),
      ),
  );
});

for (const backend of ["mcp", "addin"])
  test(`${backend} validates origin before any session and preserves it across its real transformation`, async () => {
    const source = original(),
      manifest = pythonArtifactManifest(source);
    const client = createBrokerTransport(
      {
        backend,
        tool: "fusion_mcp_execute",
        url: "http://queue.invalid",
        timeoutMs: 1000,
      },
      {
        version: "fixture",
        requestTimeout: (s) => present(s.timeoutMs),
        bridgeSource: () => assert.fail("No bridge"),
      },
    );
    let received: Record<string, unknown> | null | undefined;
    const protocol: unknown[] = [];
    client._post = (payload) => {
      protocol.push(payload["method"]);
      if (payload["method"] === "initialize")
        return Promise.resolve({
          status: 200,
          raw: JSON.stringify({
            jsonrpc: "2.0",
            id: payload["id"],
            result: {
              protocolVersion: at(payload, "params", "protocolVersion"),
            },
          }),
        });
      if (payload["method"] === "notifications/initialized")
        return Promise.resolve({ status: 202, raw: "" });
      return assert.fail("Local preparation must not dispatch an SDK tool");
    };
    client.preparePost = async (payload, origin) => {
      received = { payload, origin };
      return { fence() {}, send: () => assert.fail("Do not send fixture") };
    };
    await client.prepareCallTool(
      {
        featureType: "script",
        object: { script: source.script, readOnly: true },
      },
      "fusion_mcp_execute",
      manifest,
    );
    assert.equal(at(received, "origin", "artifactHash"), source.artifactHash);
    assert.equal(
      at(received, "payload", "params", "name"),
      backend === "addin" ? "execute_python" : "fusion_mcp_execute",
    );
    assert.deepEqual(protocol, []);
    received = null;
    await assert.rejects(
      client.prepareCallTool(
        {
          featureType: "script",
          object: { script: source.script + "\npass", readOnly: true },
        },
        "fusion_mcp_execute",
        manifest,
      ),
      { code: "PYTHON_CONTEXT_CHANGED" },
    );
    assert.equal(received, null);
    assert.deepEqual(
      protocol,
      [],
      "Invalid source inventory sends no protocol requests",
    );
  });

test("conditional run contract checks real module bindings and refuses unresolved dynamic entrypoints", async () => {
  const checker = createPythonChecker({
    typingRoot: path.join(runtime, "typing"),
    definitionsRoot: path.join(runtime, "typing"),
    pythonPlatform: "Windows",
  });
  const check = (source: string) =>
    checker.check({
      artifact: preparePythonArtifact([
        { id: "user", filename: "conditional.py", source, role: "user" },
      ]),
      context: { kind: "raw", entrypoint: "run-if-present" },
    });
  for (const source of [
    "value: int = 1",
    "def run(context: str) -> None:\n    pass",
    "def other(context: str) -> None:\n    run: int = 42",
    "values: list[int] = [run for run in (1, 2)]",
  ])
    assert.equal((await check(source)).status, "passed");
  for (const source of [
    "def run(context: int) -> None:\n    pass",
    "def other(context: int = (run := 42)) -> None:\n    pass",
  ])
    assert.equal((await check(source)).status, "failed");
  assert.equal(
    (await check('exec("def run(context: int) -> None: pass")')).status,
    "incomplete",
  );
});

test("actual cad-v1 helper stage receipt retains all source units and namespace contexts", (t) => {
  const directory = fs.mkdtempSync("/tmp/opencode/admission-cadv1-context-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source =
    'ARGS = []\nDOC_NAME = ""\ndef run(context: str) -> None:\n    stage = FMCAD.stage()\n    journal = FMCAD.journalInspect()\n    plan = FMCAD.resumePlan()\n    print(stage, journal, plan)\n';
  const file = path.join(directory, "stage.py");
  fs.writeFileSync(file, source);
  const original = (
    load("../src/run") as typeof import("../src/composition/run")
  ).prepareRunScript(
    file,
    [],
    false,
    "Fixture",
    { docId: "creation-123" },
    "cad-v1",
    [],
  );
  const final = retainPythonOrigin(
    prepareReceiptScript(
      original.script,
      true,
      "/offline/stage-context.json",
      { jobId: "stage-context" },
      { mapPath: (value) => value },
    ),
    pythonArtifactManifest(original),
  );
  assert.equal(retainedOrigin(final).units.length, original.units.length);
  assert.ok(retainedOrigin(final).units.length > 100);
  assert.deepEqual(
    at(retainedOrigin(final).context, "unitContexts", "user-script"),
    {
      kind: "cad-v1",
      deferredFacade: true,
      entrypoint: "run-if-present",
    },
  );
  const contexts = pythonUnitContexts(final);
  const helper = final.units.find((unit) => unit.filename === file);
  const combined = final.units.find(
    (unit) => unit.filename === "<fmcad-queue>",
  );
  assert.ok(helper && combined);
  assert.deepEqual(contexts[helper.id], {
    kind: "cad-v1",
    deferredFacade: true,
    entrypoint: "run-if-present",
  });
  assert.deepEqual(contexts[combined.id], {
    kind: "raw",
    entrypoint: "run",
  });
});

test("actual cad-v1 helper stage context is typed and retained in the final receipt analysis", async (t) => {
  const directory = fs.mkdtempSync("/tmp/opencode/admission-cadv1-stage-");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source =
    'ARGS = []\nDOC_NAME = ""\ndef run(context: str) -> None:\n    stage = FMCAD.stage()\n    journal = FMCAD.journalInspect()\n    plan = FMCAD.resumePlan()\n    print(stage, journal, plan)\n';
  const file = path.join(directory, "stage.py");
  fs.writeFileSync(file, source);
  const original = (
    load("../src/run") as typeof import("../src/composition/run")
  ).prepareRunScript(
    file,
    [],
    false,
    "Fixture",
    { docId: "creation-123" },
    "cad-v1",
    [],
  );
  const wrapped = prepareReceiptScript(
    original.script,
    true,
    "/offline/stage.json",
    { jobId: "stage-context" },
    { mapPath: (value) => value },
  );
  const final = retainPythonOrigin(wrapped, pythonArtifactManifest(original));
  const certificate = await admission().check(official(final.script), final);
  assert.ok(certificate.report);
  assert.equal(
    certificate.report.status,
    "passed",
    JSON.stringify(certificate.report.diagnostics),
  );
  assert.equal(
    present(
      pythonUnitContexts(final)[
        present(final.units.find((unit) => unit.filename === file)).id
      ],
    ).deferredFacade,
    true,
  );
  const invalid = file.replace(/stage\.py$/, "invalid.py");
  fs.writeFileSync(
    invalid,
    'ARGS = []\nDOC_NAME = ""\ndef run(context: str) -> None:\n    FMCAD.stage().not_an_owner_receipt()\n',
  );
  const invalidOriginal = (
    load("../src/run") as typeof import("../src/composition/run")
  ).prepareRunScript(
    invalid,
    [],
    false,
    "Fixture",
    { docId: "creation-123" },
    "cad-v1",
    [],
  );
  const invalidFinal = retainPythonOrigin(
    prepareReceiptScript(
      invalidOriginal.script,
      true,
      "/offline/invalid.json",
      { jobId: "invalid-stage" },
      { mapPath: (value) => value },
    ),
    pythonArtifactManifest(invalidOriginal),
  );
  await assert.rejects(
    admission().check(official(invalidFinal.script), invalidFinal),
    (error) =>
      record(error)["code"] === "PYTHON_CHECK_REJECTED" &&
      diagnostics(error).some(
        (d) =>
          d["rule"] === "reportAttributeAccessIssue" &&
          d["filename"] === invalid,
      ),
  );
});

test("direct checker snapshots valid mutable input before asynchronous analysis", async () => {
  const checker = createPythonChecker({
    typingRoot: path.join(runtime, "typing"),
    definitionsRoot: path.join(runtime, "typing"),
    pythonPlatform: "Windows",
  });
  const original = preparePythonArtifact([
    {
      id: "user",
      filename: "mutable.py",
      source: "value: int = 1",
      role: "user",
    },
  ]);
  const input: import("@fmcad/core").PythonCheckRequest = {
    artifact: structuredClone(original),
    context: { kind: "raw" },
  };
  const pending = checker.check(input);
  Object.assign(
    input.artifact,
    preparePythonArtifact([
      {
        id: "user",
        filename: "mutable.py",
        source: 'value: int = "bad"',
        role: "user",
      },
    ]),
  );
  const result = await pending;
  assert.equal(result.status, "passed");
  assert.equal(result.provenance.artifactHash, original.artifactHash);
  const namespaces: {
    artifact: PreparedPythonArtifact;
    context: { kind: "raw"; app?: boolean };
  } = {
    artifact: preparePythonArtifact([
      {
        id: "user",
        filename: "namespace.py",
        source: 'app.userInterface.messageBox("not injected")',
        role: "user",
      },
    ]),
    context: { kind: "raw" },
  };
  const missing = checker.check(namespaces);
  namespaces.context.app = true;
  assert.equal(
    (await missing).status,
    "failed",
    "A late caller mutation must not inject globals after context provenance was bound",
  );
});

test("large final receipt uses bounded source files without raising diagnostic limits or hiding source errors", async () => {
  const checker = createPythonChecker({
    typingRoot: path.join(runtime, "typing"),
    definitionsRoot: path.join(runtime, "typing"),
    pythonPlatform: "Windows",
    limits: { outputBytes: 64 * 1024 },
  });
  const prefix = "# " + "x".repeat(1200000) + "\n";
  for (const [body, status] of [
    ["    pass", "passed"],
    ['    value: int = "bad"', "failed"],
  ]) {
    const artifact = receipt(
      preparePythonArtifact([
        {
          id: "large",
          filename: "large.py",
          role: "user",
          source: prefix + "def run(context: str) -> None:\n" + body,
        },
      ]),
    );
    assert.ok(artifact.bytes.length > 1024 * 1024);
    const report = await checker.check({
      artifact,
      context: { kind: "raw" },
      unitContexts: pythonUnitContexts(artifact),
    });
    assert.equal(report.status, status, JSON.stringify(report.reasons));
    if (status === "failed")
      assert.ok(
        report.diagnostics.some(
          (d) =>
            d["filename"] === "large.py" &&
            d["line"] === 3 &&
            d["rule"] === "reportAssignmentType",
        ),
      );
  }
  const probe = preparePythonArtifact([
    { id: "user", filename: "user.py", role: "user", source: "import project" },
  ]);
  const hidden = await checker.check({
    artifact: probe,
    context: { kind: "raw" },
  });
  assert.ok(
    hidden.diagnostics.some((d) => d["rule"] === "reportMissingImports"),
    "The local inventory helper must not become an importable SDK dependency",
  );
  const longName = "logical-" + "x".repeat(2048) + ".py";
  const many = preparePythonArtifact([
    {
      id: "user",
      filename: longName,
      role: "user",
      source: Array.from(
        { length: 60 },
        (_, index) => `value_${index}: int = "bad"`,
      ).join("\n"),
    },
  ]);
  const bounded = await checker.check({
    artifact: many,
    context: { kind: "raw" },
  });
  assert.equal(bounded.status, "tool_error");
  assert.ok(
    bounded.reasons.some((reason) =>
      reason.includes("Mapped checker report exceeds output limit"),
    ),
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(bounded)) < 64 * 1024,
    "Original filenames must not inflate mapped diagnostics beyond the response bound",
  );
});

test("generated typed literals preserve JSON values and do not introduce dynamic loader types", async () => {
  const { pythonLiteral } = load(
    "../src/python",
  ) as typeof import("../packages/node-adapters/src/python/artifact") &
    typeof import("../packages/node-adapters/src/python/context-binding") &
    typeof import("../packages/node-adapters/src/python/checker") &
    typeof import("../packages/node-adapters/src/python/admission");
  const decode = load("./fixtures/python-literal.cjs") as (
    source: string,
  ) => unknown;
  for (const value of [
    {
      unicode: "😀 日本語",
      controls: "\b\f\n\r\t\u0000",
      quote: '"\\',
      lone: "\ud800",
    },
    [
      true,
      false,
      null,
      NaN,
      Infinity,
      -Infinity,
      undefined,
      { absent: undefined, value: -1e21 },
    ],
    123,
    "abc",
  ])
    assert.deepEqual(
      decode(pythonLiteral(value)),
      JSON.parse(JSON.stringify(value)),
    );
  assert.throws(() => pythonLiteral(undefined), /serializable/);
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.throws(() => pythonLiteral(cycle));
  assert.throws(() => pythonLiteral(1n));
  const source = `from typing import TypedDict\nclass Request(TypedDict):\n    name: str\n    enabled: bool\n    limit: int | None\nrequest: Request = ${pythonLiteral({ name: "😀", enabled: true, limit: null })}`;
  const artifact = preparePythonArtifact([
    { id: "literal", filename: "literal.py", role: "wrapper", source },
  ]);
  const report = await createPythonChecker({
    typingRoot: path.join(runtime, "typing"),
  }).check({ artifact, context: { kind: "raw" } });
  assert.equal(report.status, "passed", JSON.stringify(report));
});

test("persisted manifest boundary validates source inventory before canonical reconstruction", () => {
  const artifact = original(),
    manifest = pythonArtifactManifest(artifact);
  assert.deepEqual(
    bindPythonArtifactManifest(
      artifact.script,
      JSON.parse(JSON.stringify(manifest)),
    ),
    manifest,
  );
  for (const value of [
    null,
    [],
    1,
    { ...manifest, units: null },
    { ...manifest, sourceMap: {} },
  ])
    assert.throws(() => bindPythonArtifactManifest(artifact.script, value), {
      code: "PYTHON_CONTEXT_CHANGED",
    });
  for (const change of [
    (m: MutableManifest) => {
      present(m.units[0])["source"] = 3;
    },
    (m: MutableManifest) => {
      present(m.units[0])["role"] = "invented";
    },
    (m: MutableManifest) => {
      present(m.units[0])["id"] = null;
    },
    (m: MutableManifest) => {
      present(m.sourceMap[0])["unitId"] = [];
    },
  ]) {
    const changed = mutableManifest(manifest);
    change(changed);
    assert.throws(() => bindPythonArtifactManifest(artifact.script, changed), {
      code: "PYTHON_CONTEXT_CHANGED",
    });
  }
});
