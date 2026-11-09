import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import type { RequestContext } from "../packages/core/src/domain/contracts";
const load = createRequire(
  path.join(process.cwd(), "tests/selection-rules-e2e.test.ts"),
);
const { id } = load(
  "../packages/core/dist/domain/contracts",
) as typeof import("../packages/core/src/domain/contracts");

const { catalog, contracts, mcpInvocation, mcpTools, validateCad } = load(
  "../src/catalog",
) as typeof import("../src/composition/library-catalog-registry");
const { commands, findCommand } = load(
  "../src/commands",
) as typeof import("../src/composition/library-commands");
const { detail } = load(
  "../src/help",
) as typeof import("../src/composition/library-help");
const { executeInvocation } = load(
  "../src/catalog/execute",
) as typeof import("../src/composition/catalog-execution");
const { fromParsedCommand, execute: executeCli } = load(
  "../src/cad-service",
) as typeof import("../src/composition/cad-service");
const nodeAdapters = load(
  "../packages/node-adapters/dist",
) as typeof import("../packages/node-adapters/src");
const { createArtifactStore } = load(
  "../packages/node-adapters/dist/persistence/artifact-store.js",
) as typeof import("../packages/node-adapters/src/persistence/artifact-store");
const { createSelectionRuleArtifactClient, validateReference } = load(
  "../packages/node-adapters/dist/persistence/selection-rules.js",
) as typeof import("../packages/node-adapters/src/persistence/selection-rules");

function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
function field(value: unknown, ...keys: string[]): unknown {
  return keys.reduce((current, key) => record(current)[key], value);
}
const target = {
  doc: "SelectionFixture",
  docId: "creation-selection-1",
  docFileId: "file-selection-1",
  projectId: "project-selection-1",
};

function definition() {
  return {
    ruleId: "outer-side",
    query: {
      kind: "face",
      occurrence: "Part:1",
      filters: { geometry: "plane", axis: [1, 0, 0] },
      expect: 1,
    },
    exclude: [],
  };
}

function manifest(revision = 1, token = "face-token-1") {
  return {
    schemaVersion: 1,
    revision,
    rule: {
      id: "outer-side",
      version: 1,
      query: {
        schemaVersion: 1,
        kind: "face",
        occurrence: "Part:1",
        filters: { geometry: "plane", axis: [1, 0, 0] },
        expect: { min: 1, max: 1 },
      },
      exclude: [],
    },
    owner: {
      projectId: id("project", target.projectId),
      documentFileId: target.docFileId,
      documentCreationId: target.docId,
    },
    source: { documentName: target.doc, version: 11 },
    instanceScope: { occurrence: "Part:1" },
    lastResolution: {
      sourceVersion: 11,
      count: 1,
      selectedReferences: [{ reference: { kind: "face", token } }],
    },
    provenance: {
      definedBy: "selection.rule.define",
      resolver: "entity._entity_query",
      projectId: id("project", target.projectId),
      documentFileId: target.docFileId,
      documentCreationId: target.docId,
      sourceVersion: 11,
      ...(revision > 1
        ? { lastResolvedBy: "selection.rule.resolve", lastResolvedVersion: 11 }
        : {}),
    },
  };
}

function internalResult(operation: string, payload: unknown, success = true) {
  return {
    text:
      "FMCAD_RESULT " +
      JSON.stringify({
        success,
        operation,
        document: target.doc,
        result: payload,
      }),
  };
}

function invocation(operation: string, data: unknown, context = target) {
  const name = "fmcad_cad_" + operation.replaceAll(".", "_");
  return mcpInvocation(name, { ...context, data }).invocation;
}

function temporaryProject(t: import("node:test").TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fmcad-selection-rules-"));
  fs.mkdirSync(path.join(root, ".cad"), { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("selection rule registry, MCP schema, CLI route, helper index, and help are canonical", () => {
  assert.equal(typeof nodeAdapters.createArtifactStore, "function");
  assert.equal(
    typeof nodeAdapters.createSelectionRuleArtifactClient,
    "function",
  );
  assert.equal(typeof nodeAdapters.withSelectionRules, "function");
  for (const operation of [
    "selection.rule.define",
    "selection.rule.inspect",
    "selection.rule.resolve",
    "selection.rule.check",
  ]) {
    assert.ok(catalog[operation]);
    assert.equal(contracts[operation]!.service.handler, "selection-rules");
    assert.equal(contracts[operation]!.requirements.document, true);
    assert.equal(contracts[operation]!.declaration.documentPin, true);
    assert.ok(
      mcpTools.some((tool) => tool._meta.fmcad.operation === operation),
    );
  }
  for (const operation of [
    "selection.rule.define_internal",
    "selection.rule.inspect_internal",
    "selection.rule.resolve_internal",
    "selection.rule.check_internal",
  ]) {
    assert.equal(catalog[operation], undefined);
    assert.ok(
      !mcpTools.some((tool) => tool._meta.fmcad.operation === operation),
    );
  }
  assert.ok(findCommand(["selection", "rule", "define"]));
  assert.equal(
    commands.find((route) => route.target === "selection.rule.resolve")!.kind,
    "cad",
  );
  assert.match(
    detail("selection", "rule", "resolve"),
    /first match|first-result|Historical native references/,
  );
  assert.deepEqual(
    (
      load(
        "../packages/core/dist/catalog/capabilities.js",
      ) as typeof import("../packages/core/src/catalog/capabilities")
    ).CAD_V1_HELPERS.filter((helper) =>
      helper.id.startsWith("selection_rule_"),
    ).map((helper) => helper.method),
    [
      "FMCAD.selection_rule_define",
      "FMCAD.selection_rule_inspect",
      "FMCAD.selection_rule_resolve",
      "FMCAD.selection_rule_check",
    ],
  );
  assert.match(
    (
      load(
        "../packages/core/dist/catalog/capabilities.js",
      ) as typeof import("../packages/core/src/catalog/capabilities")
    ).CAD_V1_HELPERS.find(
      (helper) => helper.id === "selection_rule_define",
    )!.limitations.join(" "),
    /does not persist/i,
  );

  assert.throws(
    () =>
      validateCad("selection.rule.define", {
        ruleId: "bad",
        query: { kind: "face", expect: 1 },
      }),
    /explicit component, occurrence, body, feature, or instances:true scope/,
  );
  assert.throws(
    () =>
      validateCad("selection.rule.define", {
        ruleId: "bad",
        query: { kind: "face", occurrence: "Part:1", filters: {}, expect: 1 },
        unique: true,
      }),
    /Unknown CAD inputs/,
  );
});

test("typed CLI and MCP fake-broker flows persist and re-resolve owned selection artifacts", async (t) => {
  const project = temporaryProject(t);
  const responses: ReturnType<typeof internalResult>[] = [];
  const calls: string[] = [];
  const broker = {
    async callTool(request: { object: { script: string } }) {
      const script = request?.object?.script;
      assert.equal(typeof script, "string");
      assert.match(
        script,
        /selection\.rule\.(define|inspect|resolve|check)_internal/,
      );
      calls.push(script);
      const response = responses.shift();
      assert.ok(response, "fake broker response must be explicitly queued");
      return response;
    },
  };

  responses.push(
    internalResult("selection.rule.define_internal", {
      ...manifest(),
      operation: "selection.rule.define",
      success: true,
      status: "pass",
      ruleId: "outer-side",
      count: 1,
      refs: [{ kind: "face", token: "face-token-1" }],
      entities: [{ kind: "face", token: "face-token-1" }],
      excludedCount: 0,
      manifest: manifest(),
      provenance: manifest().provenance,
      method: "entity._entity_query",
      limitations: [],
    }),
  );
  const parsed = fromParsedCommand({
    kind: "cad",
    operation: "selection.rule.define",
    data: definition(),
    context: target,
    json: true,
  });
  const stdout: string[] = [];
  const exitCode = await executeCli(
    parsed,
    broker,
    () => {},
    { stdout: { write: (text) => stdout.push(text) }, stderr: { write() {} } },
    { projectDirectory: project },
  );
  assert.equal(exitCode, 0);
  const defined: unknown = JSON.parse(stdout.join(""));
  assert.equal(field(defined, "result", "ruleId"), "outer-side");
  const original = validateReference(field(defined, "result", "artifact"));
  assert.equal(original.projectId, target.projectId);
  assert.equal(original.documentFileId, target.docFileId);
  assert.equal(
    fs.readdirSync(path.join(project, ".cad", "artifacts")).length,
    1,
  );

  const inspectedManifest = manifest();
  responses.push(
    internalResult("selection.rule.inspect_internal", {
      success: true,
      operation: "selection.rule.inspect",
      status: "pass",
      ruleId: "outer-side",
      revision: 1,
      owner: inspectedManifest.owner,
      source: inspectedManifest.source,
      instanceScope: inspectedManifest.instanceScope,
      expectedCardinality: inspectedManifest.rule.query.expect,
      lastResolution: inspectedManifest.lastResolution,
      provenance: inspectedManifest.provenance,
      manifest: inspectedManifest,
    }),
  );
  const inspect = await executeInvocation(
    invocation("selection.rule.inspect", { artifact: original }),
    broker,
    () => {},
    { projectDirectory: project },
  );
  assert.equal(field(inspect, "success"), true);
  assert.equal(field(inspect, "result", "lastResolution", "count"), 1);
  assert.equal(
    validateReference(field(inspect, "result", "artifact")).artifactId,
    original.artifactId,
  );

  const advanced = manifest(2, "face-token-2");
  responses.push(
    internalResult("selection.rule.resolve_internal", {
      success: true,
      operation: "selection.rule.resolve",
      status: "resolved",
      passed: true,
      ruleId: "outer-side",
      revision: 2,
      source: advanced.source,
      sourceChanged: false,
      expectedCardinality: advanced.rule.query.expect,
      count: 1,
      refs: [{ kind: "face", token: "face-token-2" }],
      entities: [{ kind: "face", token: "face-token-2" }],
      excludedCount: 0,
      changes: [],
      manifest: advanced,
      provenance: {
        resolver: "entity._entity_query",
        owner: advanced.owner,
        sourceVersion: 11,
        ruleRevision: 1,
      },
      method: "fresh current-topology query",
      limitations: [],
    }),
  );
  const resolved = await executeInvocation(
    invocation("selection.rule.resolve", { artifact: original }),
    broker,
    () => {},
    { projectDirectory: project },
  );
  assert.equal(field(resolved, "success"), true);
  assert.equal(field(resolved, "result", "status"), "resolved");
  const updated = validateReference(field(resolved, "result", "artifact"));
  assert.notEqual(updated.artifactId, original.artifactId);
  assert.equal(
    fs.readdirSync(path.join(project, ".cad", "artifacts")).length,
    2,
  );

  responses.push(
    internalResult("selection.rule.check_internal", {
      success: true,
      operation: "selection.rule.check",
      status: "resolved",
      passed: true,
      ruleId: "outer-side",
      revision: 2,
      source: advanced.source,
      sourceChanged: false,
      expectedCardinality: advanced.rule.query.expect,
      count: 1,
      refs: [{ kind: "face", token: "face-token-2" }],
      entities: [{ kind: "face", token: "face-token-2" }],
      excludedCount: 0,
      changes: [],
      manifest: advanced,
      provenance: {
        resolver: "entity._entity_query",
        owner: advanced.owner,
        sourceVersion: 11,
        ruleRevision: 2,
      },
      method: "fresh current-topology query",
      limitations: [],
    }),
  );
  const checked = await executeInvocation(
    invocation("selection.rule.check", { artifact: updated }),
    broker,
    () => {},
    { projectDirectory: project },
  );
  assert.equal(field(checked, "success"), true);
  assert.equal(field(checked, "result", "passed"), true);
  assert.equal(
    validateReference(field(checked, "result", "artifact")).artifactId,
    updated.artifactId,
  );

  responses.push(
    internalResult("selection.rule.resolve_internal", {
      success: false,
      operation: "selection.rule.resolve",
      status: "split",
      passed: false,
      ruleId: "outer-side",
      revision: 2,
      source: advanced.source,
      sourceChanged: false,
      expectedCardinality: advanced.rule.query.expect,
      count: 2,
      refs: [
        { kind: "face", token: "split-face-a" },
        { kind: "face", token: "split-face-b" },
      ],
      entities: [],
      excludedCount: 0,
      changes: [{ kind: "split" }],
      manifest: advanced,
      provenance: {
        resolver: "entity._entity_query",
        owner: advanced.owner,
        sourceVersion: 11,
        ruleRevision: 2,
      },
      method: "fresh current-topology query",
      limitations: [],
    }),
  );
  const split = await executeInvocation(
    invocation("selection.rule.resolve", { artifact: updated }),
    broker,
    () => {},
    { projectDirectory: project },
  );
  assert.equal(field(split, "success"), false);
  assert.equal(field(split, "result", "status"), "split");
  assert.equal(
    validateReference(field(split, "result", "artifact")).artifactId,
    updated.artifactId,
  );
  assert.equal(
    fs.readdirSync(path.join(project, ".cad", "artifacts")).length,
    2,
  );

  const callCount = calls.length;
  await assert.rejects(
    executeInvocation(
      invocation(
        "selection.rule.inspect",
        { artifact: updated },
        { ...target, docFileId: "other-file" },
      ),
      broker,
      () => {},
      { projectDirectory: project },
    ),
    /pinned docFileId differs/,
  );
  assert.equal(calls.length, callCount);

  const file = path.join(
    project,
    ".cad",
    "artifacts",
    updated.artifactId + ".json",
  );
  const envelope: { content: string } = JSON.parse(
    fs.readFileSync(file, "utf8"),
  );
  envelope.content += " ";
  fs.writeFileSync(file, JSON.stringify(envelope));
  await assert.rejects(
    executeInvocation(
      invocation("selection.rule.inspect", { artifact: updated }),
      broker,
      () => {},
      { projectDirectory: project },
    ),
    /content hash mismatch/,
  );
  assert.equal(calls.length, callCount);
});

test("artifact store reads durable selection manifests across service instances and rejects foreign owner/hash", async (t) => {
  const project = temporaryProject(t);
  const artifactStore = createArtifactStore(project);
  const first = createSelectionRuleArtifactClient(artifactStore);
  const value = manifest();
  const context: RequestContext = {
    version: 1,
    clientId: id("client", "client-1"),
    requestId: id("request", "request-1"),
    sessionId: null,
    projectId: id("project", target.projectId),
    documentId: id("document", target.docFileId),
    instanceId: id("instance", "instance-1"),
    purpose: null,
  };
  const reference = await first.write(context, value);
  const restored = await createSelectionRuleArtifactClient(
    createArtifactStore(project),
  ).read(context, reference);
  assert.deepEqual(restored, value);
  await assert.rejects(
    first.read(
      { ...context, documentId: id("document", "other-file") },
      reference,
    ),
    /different project or document/,
  );
  await assert.rejects(
    first.read(
      { ...context, projectId: id("project", "other-project") },
      reference,
    ),
    /different project or document/,
  );
  const recordPath = path.join(
    project,
    ".cad",
    "artifacts",
    reference.artifactId + ".json",
  );
  const stored: { content: string } = JSON.parse(
    fs.readFileSync(recordPath, "utf8"),
  );
  stored.content = stored.content.replace("face-token-1", "face-token-X");
  fs.writeFileSync(recordPath, JSON.stringify(stored));
  await assert.rejects(first.read(context, reference), /hash mismatch/);
});
