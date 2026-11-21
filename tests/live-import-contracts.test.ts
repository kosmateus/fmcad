import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  methodCall,
  parseDocumentStatus,
  parseFixedEnvelope,
  parseFixedPayload,
  parseFixtureContract,
  parseMethodResult,
  parseRuntimeBuild,
} from "./fixed-import-result-contracts.js";
import {
  parseCadCliOutput,
  parseDocumentSnapshot,
  parseRuntimeConfig,
  requiredItem,
  validateOperationResult,
  assertLocalImportOutcome,
} from "./import-result-contracts.js";
import { asArray, asRecord } from "./live-import-receipts.js";
import { cad } from "./integration/offline-cli";

function fixedPayload() {
  const status = {
    name: "owned",
    creationId: "owned-id",
    saved: false,
    modified: true,
    fileId: null,
  };
  return {
    version: 1,
    document: {
      name: status.name,
      creationId: status.creationId,
      before: status,
      after: { ...status },
    },
    fusionVersion: "synthetic-contract-input",
    fixturePrefix: "owned-prefix",
    modelChangedByFixture: true,
    nativeGeometry: true,
    designBefore: { componentCount: 0 },
    calls: [
      {
        operation: "param.import",
        result: {
          status: "pass",
          operation: "param.import",
          documentIdentity: { creationId: status.creationId },
          instances: [{ id: "instance" }],
          component: { name: "component" },
          bodies: ["body"],
          differences: [],
          unresolved: [{ id: "part", field: "material", status: "unknown" }],
          datumChecks: [{ status: "pass" }],
        },
      },
    ],
    paramReadback: [{ name: "width", expression: "5 mm", value: 0.5 }],
    catalogInstances: [{ id: "instance" }],
    catalogDifferences: [],
    placementReadback: [{ status: "pass", actual: [1, 0, 0, 2.5] }],
    cotsReadback: {
      materialStatus: "unknown",
      oldPath: "old:1",
      newPath: "new:1",
      sourceVolumeMm3: 385,
      replacementVolumeMm3: 385,
    },
    removedFiles: ["owned.step"],
    artifactPaths: ["owned.step"],
    artifactDirectoryRemoved: true,
    artifactDirectory: "owned-directory",
    negativeCases: "not-run",
    cleanup: { ownerRetainsDocument: true },
  };
}

function change(
  value: unknown,
  keys: readonly (string | number)[],
  replacement: unknown,
): unknown {
  const copy: unknown = structuredClone(value);
  let target = copy;
  for (const key of keys.slice(0, -1))
    target =
      typeof key === "number"
        ? asArray(target, "array field")[key]
        : asRecord(target, "object field")[key];
  const final = keys.at(-1);
  assert.ok(final !== undefined);
  if (typeof final === "number")
    asArray(target, "array target")[final] = replacement;
  else asRecord(target, "object target")[final] = replacement;
  return copy;
}

test("fixed import output parsers execute every nonempty retained descriptor branch without native qualification", () => {
  const payload = fixedPayload();
  assert.deepEqual(parseFixedPayload(payload), payload);
  const envelope = {
    success: true,
    result: payload,
    helperCallsOnly: [
      { operation: "param.import", status: "pass", effects: "changed" },
    ],
  };
  assert.deepEqual(parseFixedEnvelope(envelope), envelope);
  assert.deepEqual(parseMethodResult({ status: "unknown" }, "minimal"), {
    status: "unknown",
  });
  assert.deepEqual(
    parseMethodResult({ status: "pass", component: {} }, "unnamed component"),
    { status: "pass", component: {} },
  );
  const manifest = {
    fixtureId: "fixture",
    kind: "fixed-run-v1",
    helperVersion: "cad-v1",
    script: "owned.py",
    scriptSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
  };
  assert.deepEqual(parseFixtureContract(manifest), manifest);
  for (const key of Object.keys(manifest))
    assert.throws(
      () => parseFixtureContract({ ...manifest, [key]: null }),
      /must be a string/u,
    );
  assert.deepEqual(parseRuntimeBuild({ fingerprint: "build" }), {
    fingerprint: "build",
  });
  assert.throws(() => parseRuntimeBuild({ fingerprint: null }));
  assert.deepEqual(
    parseDocumentStatus(
      { ...payload.document.before, fileId: "saved-file", saved: true },
      "saved",
    ),
    { ...payload.document.before, fileId: "saved-file", saved: true },
  );
  const malformed: Array<[readonly (string | number)[], unknown]> = [
    [["version"], "1"],
    [["document", "name"], null],
    [["document", "creationId"], null],
    [["document", "before", "creationId"], null],
    [["document", "before", "name"], null],
    [["document", "before", "saved"], "false"],
    [["document", "before", "modified"], "true"],
    [["document", "before", "fileId"], 1],
    [["fusionVersion"], null],
    [["fixturePrefix"], null],
    [["modelChangedByFixture"], "true"],
    [["nativeGeometry"], "true"],
    [["calls", 0, "operation"], null],
    [["calls", 0, "result", "status"], null],
    [["calls", 0, "result", "documentIdentity", "creationId"], null],
    [["calls", 0, "result", "instances", 0, "id"], null],
    [["calls", 0, "result", "component", "name"], 1],
    [["calls", 0, "result", "bodies"], {}],
    [["calls", 0, "result", "differences"], {}],
    [["calls", 0, "result", "unresolved", 0, "id"], null],
    [["calls", 0, "result", "unresolved", 0, "field"], null],
    [["calls", 0, "result", "unresolved", 0, "status"], null],
    [["calls", 0, "result", "datumChecks", 0, "status"], null],
    [["paramReadback", 0, "name"], null],
    [["paramReadback", 0, "expression"], null],
    [["paramReadback", 0, "value"], "0.5"],
    [["catalogInstances", 0, "id"], null],
    [["placementReadback", 0, "status"], null],
    [["placementReadback", 0, "actual", 0], Number.POSITIVE_INFINITY],
    [["cotsReadback", "materialStatus"], null],
    [["cotsReadback", "oldPath"], null],
    [["cotsReadback", "newPath"], null],
    [["cotsReadback", "sourceVolumeMm3"], "385"],
    [["cotsReadback", "replacementVolumeMm3"], "385"],
    [["artifactPaths"], {}],
    [["artifactPaths", 0], 1],
    [["artifactDirectoryRemoved"], "true"],
    [["artifactDirectory"], null],
    [["negativeCases"], null],
  ];
  for (const [keys, value] of malformed)
    assert.throws(
      () => parseFixedPayload(change(payload, keys, value)),
      keys.join("."),
    );
  for (const [keys, value] of [
    [["success"], "true"],
    [["helperCallsOnly", 0, "operation"], null],
    [["helperCallsOnly", 0, "status"], null],
    [["helperCallsOnly", 0, "effects"], null],
  ] as Array<[readonly (string | number)[], unknown]>)
    assert.throws(
      () => parseFixedEnvelope(change(envelope, keys, value)),
      keys.join("."),
    );
  assert.deepEqual(
    methodCall(parseFixedPayload(payload), "param.import"),
    payload.calls[0]?.result,
  );
  assert.throws(
    () => methodCall(parseFixedPayload(payload), "missing"),
    /exactly once/u,
  );
  assert.throws(
    () =>
      methodCall(
        parseFixedPayload({
          ...payload,
          calls: [...payload.calls, ...payload.calls],
        }),
        "param.import",
      ),
    /exactly once/u,
  );
  assert.throws(
    () =>
      Reflect.apply(methodCall, undefined, [
        change(payload, ["calls", 0, "result"], null),
        "param.import",
      ]),
    /returned no result record/u,
  );
});

test("retained import CLI parsers preserve all result families and reject malformed nonempty rows", () => {
  const inputs = [
    [
      "param.import",
      { parameters: [{ name: "width", expression: "5 mm", value: 0.5 }] },
    ],
    [
      "param.inspect",
      { parameters: [{ name: "width", expression: "5 mm", value: 0.5 }] },
    ],
    [
      "catalog.import",
      {
        instances: [{ id: "part", occurrence: { path: "part:1" } }],
        idMap: { part: { definition: "part" } },
      },
    ],
    [
      "catalog.check",
      {
        instances: [{ id: "part", occurrence: { path: "part:1" } }],
        differences: [],
      },
    ],
    [
      "placement.import",
      { poses: [{ status: "pass", actual: [1, 0, 0, 2.5] }] },
    ],
    [
      "placement.check",
      { poses: [{ status: "pass", actual: [1, 0, 0, 2.5] }] },
    ],
    [
      "cots.replace",
      {
        replacements: [{ before: { path: "old:1" }, after: { path: "new:1" } }],
        datumChecks: [{ status: "pass" }],
        unresolved: [{ field: "material", status: "unknown" }],
      },
    ],
    ["entity.inspect", { kind: "occurrence", occurrencePath: "part:1" }],
    ["component.inspect", { component: { name: "part" }, bodies: ["body"] }],
    ["component.create", { component: { name: "part" } }],
    ["shape.box", { bodies: ["body"] }],
    ["measure.volume", { value: 385 }],
    ["export.step", { exists: true, bytes: 123 }],
    ["entity.list", { entities: [{ path: "part:1" }] }],
  ] satisfies Array<
    [Parameters<typeof validateOperationResult>[0], Record<string, unknown>]
  >;
  for (const [operation, result] of inputs) {
    assert.doesNotThrow(() =>
      validateOperationResult(operation, "pass", result),
    );
    assert.doesNotThrow(() =>
      validateOperationResult(operation, "blocked", {
        error: "specific expected refusal",
      }),
    );
    assert.throws(() => validateOperationResult(operation, "blocked", {}));
    assert.doesNotThrow(() =>
      validateOperationResult(operation, "local-pass", {}),
    );
    assert.doesNotThrow(() =>
      validateOperationResult(operation, "local-unknown", {}),
    );
  }
  const malformed: Array<
    [Parameters<typeof validateOperationResult>[0], Record<string, unknown>]
  > = [
    ["param.import", { parameters: [{ name: 1, expression: "5", value: 5 }] }],
    [
      "param.import",
      { parameters: [{ name: "width", expression: 5, value: 5 }] },
    ],
    [
      "param.inspect",
      { parameters: [{ name: "width", expression: "5", value: "5" }] },
    ],
    ["catalog.import", { instances: [{ id: 1, occurrence: {} }], idMap: {} }],
    [
      "catalog.import",
      { instances: [{ id: "part", occurrence: null }], idMap: {} },
    ],
    [
      "catalog.import",
      {
        instances: [{ id: "part", occurrence: {} }],
        idMap: { part: { definition: 1 } },
      },
    ],
    [
      "catalog.check",
      { instances: [{ id: "part", occurrence: {} }], differences: null },
    ],
    ["placement.import", { poses: [{ status: 1, actual: [1] }] }],
    ["placement.check", { poses: [{ status: "pass", actual: [Number.NaN] }] }],
    [
      "cots.replace",
      {
        replacements: [{ before: null, after: {} }],
        datumChecks: [],
        unresolved: [],
      },
    ],
    [
      "cots.replace",
      {
        replacements: [{ before: {}, after: null }],
        datumChecks: [],
        unresolved: [],
      },
    ],
    ["entity.inspect", { kind: 1, occurrencePath: "part:1" }],
    ["entity.inspect", { kind: "occurrence", occurrencePath: null }],
    ["component.inspect", { component: { name: 1 }, bodies: [] }],
    ["component.create", { component: { name: 1 } }],
    ["shape.box", { bodies: {} }],
    ["measure.volume", { value: "385" }],
    ["measure.volume", { value: Number.POSITIVE_INFINITY }],
    ["export.step", { exists: "true", bytes: 123 }],
    ["export.step", { exists: true, bytes: "123" }],
    ["entity.list", { entities: [{ path: 1 }] }],
  ];
  for (const [operation, result] of malformed)
    assert.throws(() => validateOperationResult(operation, "pass", result));
  const envelope = {
    success: true,
    status: "pass",
    result: { value: 385 },
    document: "owned",
    documentIdentity: { creationId: "owned-id" },
    method: "native",
    modelValidated: true,
    mutation: false,
    error: "",
  };
  assert.deepEqual(parseCadCliOutput(envelope, "complete"), envelope);
  assert.deepEqual(
    parseCadCliOutput(
      { success: false, documentIdentity: null },
      "without result",
    ),
    { success: false, result: {}, documentIdentity: null },
  );
  assert.deepEqual(
    parseCadCliOutput(
      { success: false, documentIdentity: {} },
      "without identity field",
    ),
    { success: false, result: {}, documentIdentity: {} },
  );
  assert.throws(() => parseCadCliOutput({ success: "true" }, "wrong success"));
  assert.throws(() =>
    parseCadCliOutput(
      { success: true, documentIdentity: { creationId: 1 } },
      "wrong identity",
    ),
  );
  const items = ["first"];
  assert.equal(requiredItem(items, 0, "present"), "first");
  assert.throws(() => requiredItem(items, 1, "missing"));
});

test("import document snapshots reject duplicate or foreign active identities and invalid protected flags", () => {
  const snapshot = {
    documents: [
      {
        name: "owned",
        creationId: "owned-id",
        saved: false,
        modified: true,
        fileId: null,
      },
    ],
    activeCreationId: "owned-id",
  };
  assert.deepEqual(parseDocumentSnapshot(snapshot, "owned"), snapshot);
  assert.deepEqual(
    parseDocumentSnapshot({ documents: [], activeCreationId: null }, "empty"),
    { documents: [], activeCreationId: null },
  );
  for (const [key, value] of [
    ["name", 1],
    ["creationId", 1],
    ["saved", "false"],
    ["modified", "true"],
    ["fileId", 1],
  ] as const)
    assert.throws(() =>
      parseDocumentSnapshot(
        change(snapshot, ["documents", 0, key], value),
        "bad document field",
      ),
    );
  assert.throws(
    () =>
      parseDocumentSnapshot(
        {
          ...snapshot,
          documents: [...snapshot.documents, ...snapshot.documents],
        },
        "duplicate",
      ),
    /duplicate creationId/u,
  );
  assert.throws(
    () =>
      parseDocumentSnapshot(
        { ...snapshot, activeCreationId: "foreign" },
        "foreign",
      ),
    /does not identify an open document/u,
  );
  assert.throws(() =>
    parseDocumentSnapshot(
      { ...snapshot, activeCreationId: 1 },
      "bad active identity",
    ),
  );
  const cfg = { backend: "mcp", transport: "http", timeoutMs: 1000 };
  assert.deepEqual(parseRuntimeConfig({ cfg }), cfg);
  for (const [key, value] of [
    ["backend", 1],
    ["transport", 1],
    ["timeoutMs", "1000"],
  ] as const)
    assert.throws(() => parseRuntimeConfig({ cfg: { ...cfg, [key]: value } }));
});

test("retained catalog and placement preflight assertions run through the real local CLI", (t) => {
  const artifactRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "fmcad-import-local-contract-"),
  );
  t.after(() => fs.rmSync(artifactRoot, { recursive: true, force: true }));
  const owner = "owned-offline-import-contract";
  const source = "Owned synthetic Fusion fixture";
  const pose = (frame: string, x = 0) => ({
    frame,
    translation: [`${x} mm`, "0 mm", "0 mm"],
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  });
  const records = [
    {
      id: "synthetic-assembly",
      name: "Assembly",
      kind: "assembly",
      quantity: 1,
      parent: null,
      placement: pose("parent", 10),
      status: "CONFIRMED",
      source,
    },
    {
      id: "synthetic-part",
      name: "Part",
      kind: "part",
      quantity: 1,
      parent: "synthetic-assembly",
      placement: pose("parent"),
      status: "CONFIRMED",
      source,
    },
    {
      id: "synthetic-cots",
      name: "Sensor",
      kind: "purchased",
      quantity: 1,
      parent: null,
      placement: pose("parent"),
      mass: { value: 3, unit: "g", status: "ESTIMATED", source },
      status: "CONFIRMED",
      source,
    },
  ];
  const catalogPath = path.join(artifactRoot, "synthetic-catalog.json");
  fs.writeFileSync(catalogPath, JSON.stringify({ records }, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  const cases: [
    string,
    Record<string, unknown>,
    "local-pass" | "local-unknown",
  ][] = [
    [
      "catalog.check",
      {
        version: 1,
        owner,
        revision: "catalog-r1",
        source: catalogPath,
        schema: { recordsPath: "records" },
      },
      "local-pass",
    ],
    [
      "placement.check",
      {
        version: 1,
        owner,
        revision: "placement-offline",
        records: [
          {
            id: "offline-pose",
            occurrence: "not-resolved-offline",
            placement: pose("root", 1),
            status: "CONFIRMED",
            source,
          },
        ],
      },
      "local-unknown",
    ],
  ];
  for (const [operation, data, expectation] of cases) {
    const reply = cad([
      ...operation.split("."),
      "--doc",
      "offline-unresolved",
      "--doc-id",
      "offline-unresolved-id",
      "--data",
      JSON.stringify(data),
    ]);
    const output = parseCadCliOutput(reply.json, operation);
    assertLocalImportOutcome(
      operation,
      {
        status: reply.code,
        signal: reply.signal,
        stdout: reply.stdout,
        stderr: reply.stderr,
      },
      output,
      output.status ?? output.result["status"],
      expectation,
    );
  }
});
