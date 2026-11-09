import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import type { RequestContext } from "../packages/core/src/domain/contracts";
import type { ArtifactStore } from "../packages/core/src/ports";
const load = createRequire(
  path.join(process.cwd(), "tests/selection-rules-store.test.ts"),
);
const { id } = load(
  "../packages/core/dist/domain/contracts",
) as typeof import("../packages/core/src/domain/contracts");

const { cadBundleManifest, cadBundleUnits, orderBundle } = load(
  "../packages/node-adapters/dist/python/bundle.js",
) as typeof import("../packages/node-adapters/src/python/bundle");
const { preparePythonArtifact, verifyPythonArtifact } = load(
  "../packages/node-adapters/dist/python/artifact.js",
) as typeof import("../packages/node-adapters/src/python/artifact");
const { withSelectionRules } = load(
  "../packages/node-adapters/dist/python/selection-rules-manifest.js",
) as typeof import("../packages/node-adapters/src/python/selection-rules-manifest");
const { createSelectionRuleArtifactClient } = load(
  "../packages/node-adapters/dist/persistence/selection-rules.js",
) as typeof import("../packages/node-adapters/src/persistence/selection-rules");

function context(
  projectId = "project-1",
  documentId: string | null = "file-1",
): RequestContext {
  return {
    version: 1,
    clientId: id("client", "client-1"),
    requestId: id("request", "request-1"),
    sessionId: null,
    projectId: id("project", projectId),
    documentId: documentId === null ? null : id("document", documentId),
    instanceId: null,
    purpose: null,
  };
}

function manifest() {
  return {
    schemaVersion: 1,
    revision: 1,
    rule: {
      id: "outer-face",
      version: 1,
      query: {
        kind: "face",
        scope: { occurrence: "Part:1" },
        filters: { name: "Outer" },
        expect: { min: 1, max: 1 },
      },
      exclude: [],
    },
    owner: {
      projectId: "project-1",
      documentFileId: "file-1",
      documentCreationId: "creation-1",
    },
    source: { documentName: "SelectionFixture", version: 4 },
    instanceScope: { occurrence: "Part:1" },
    lastResolution: {
      sourceVersion: 4,
      count: 1,
      selectedReferences: [{ reference: { token: "face-token" } }],
    },
    provenance: {
      definedBy: "selection.rule.define",
      resolver: "entity._entity_query",
    },
  };
}

function memoryArtifactStore(): ArtifactStore & {
  records: Map<string, string>;
} {
  const records = new Map<string, string>();
  let next = 0;
  return {
    records,
    async write(requestContext, content, mediaType) {
      assert.equal(requestContext.projectId, "project-1");
      assert.equal(
        mediaType,
        "application/vnd.fmcad.selection-rule+json;version=1",
      );
      const artifactId = `artifact-${++next}`;
      records.set(`${requestContext.projectId}/${artifactId}`, content);
      return id("artifact", artifactId);
    },
    async read(requestContext, artifactId) {
      return records.get(`${requestContext.projectId}/${artifactId}`) ?? null;
    },
  };
}

test("selection manifests persist across client instances through the shared artifact store", async () => {
  const artifacts = memoryArtifactStore();
  const firstClient = createSelectionRuleArtifactClient(artifacts);
  const reference = await firstClient.write(context(), manifest());
  const secondClient = createSelectionRuleArtifactClient(artifacts);
  assert.deepEqual(await secondClient.read(context(), reference), manifest());
  assert.equal(reference.projectId, "project-1");
  assert.equal(reference.documentFileId, "file-1");
  assert.equal(reference.sha256.length, 64);
});

test("artifact ownership, envelope, and content hash are checked on read and write", async () => {
  const artifacts = memoryArtifactStore();
  const client = createSelectionRuleArtifactClient(artifacts);
  await assert.rejects(
    client.write(context("project-2", "file-1"), manifest()),
    /different project or document/,
  );
  const reference = await client.write(context(), manifest());
  await assert.rejects(
    client.read(context("project-1", "file-2"), reference),
    /different project or document/,
  );
  await assert.rejects(
    client.read(context("project-1", null), reference),
    /different project or document/,
  );
  artifacts.records.set(`project-1/${reference.artifactId}`, "{} ");
  await assert.rejects(client.read(context(), reference), /hash mismatch/);
});

test("selection-rule bundle hook orders the domain, Fusion adapter, and application owner", () => {
  const base = [
    { id: "entity", path: "assets/cad/entity.py", dependencies: [] },
  ];
  const extended = withSelectionRules(base);
  const ordered = orderBundle(extended, ["selection-rules-application"]);
  assert.deepEqual(
    ordered.map((unit) => unit.id),
    [
      "entity",
      "selection-rules-domain",
      "fusion-selection-rules",
      "selection-rules-application",
    ],
  );
  assert.equal(ordered.at(-1)!.owner, "selection-rules");
  const units = cadBundleUnits(process.cwd(), "full", cadBundleManifest);
  const selectionRuleIndex = units.findIndex(
    (unit) => unit.id === "selection-rules-domain",
  );
  assert.deepEqual(
    units
      .slice(selectionRuleIndex, selectionRuleIndex + 3)
      .map((unit) => unit.id),
    [
      "selection-rules-domain",
      "fusion-selection-rules",
      "selection-rules-application",
    ],
  );
});

test("selection rules produce a verified PreparedPythonArtifact and register in its runtime", () => {
  const units = cadBundleUnits(process.cwd(), "full", cadBundleManifest);
  const artifact = preparePythonArtifact(units, {
    context: { projectId: "project-1", documentId: "file-1" },
    request: { operation: "selection.rule.inspect" },
  });
  verifyPythonArtifact(artifact);
  const selectionRuleIndex = artifact.units.findIndex(
    (unit) => unit.id === "selection-rules-domain",
  );
  assert.deepEqual(
    artifact.units
      .slice(selectionRuleIndex, selectionRuleIndex + 3)
      .map((unit) => unit.id),
    [
      "selection-rules-domain",
      "fusion-selection-rules",
      "selection-rules-application",
    ],
  );
  assert.equal(Buffer.from(artifact.bytes).toString("utf8"), artifact.script);

  const setup = `import sys, types
adsk = types.ModuleType('adsk')
adsk.core = types.ModuleType('adsk.core')
adsk.fusion = types.ModuleType('adsk.fusion')
sys.modules.update({'adsk': adsk, 'adsk.core': adsk.core, 'adsk.fusion': adsk.fusion})
`;
  const check = `
assert CAD_HANDLERS.owners['selection.rule.define'] == 'selection-rules'
assert CAD_HANDLERS.owners['selection.rule.inspect'] == 'selection-rules'
assert CAD_HANDLERS.owners['selection.rule.resolve'] == 'selection-rules'
assert CAD_HANDLERS.owners['selection.rule.check'] == 'selection-rules'
`;
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      setup +
        "exec(compile(sys.stdin.read(), '<fmcad-artifact>', 'exec'))" +
        check,
    ],
    { input: artifact.script, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("native qualification fixture is prepared but never marked as executed", () => {
  const fixture: {
    status: string;
    requiresExplicitAuthorization: boolean;
    cases: { id: string }[];
  } = JSON.parse(
    readFileSync(
      path.join(process.cwd(), "tests/fixtures/selection-rules-native.json"),
      "utf8",
    ),
  );
  assert.equal(fixture.status, "prepared-not-run");
  assert.equal(fixture.requiresExplicitAuthorization, true);
  assert.deepEqual(
    fixture.cases.map((item) => item.id),
    [
      "reorder",
      "repeated-identical-instances",
      "split",
      "merge",
      "deleted-and-stale",
      "ownership-and-restore",
    ],
  );
});
