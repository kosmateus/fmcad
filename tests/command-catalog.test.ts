import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
const load = createRequire(__filename),
  root = process.cwd();
const { createOperationCatalog, projectMcpTools, indexCommandRoutes } = load(
  path.join(root, "src/dist/core/catalog"),
) as typeof import("../packages/core/src/catalog");
const { catalog, contracts, validateCad, mcpTools, byMcpName, mcpInvocation } =
  load(
    path.join(root, "src/catalog"),
  ) as typeof import("../src/composition/library-catalog-registry");
const { commands, findCommand } = load(
  path.join(root, "src/commands"),
) as typeof import("../src/composition/library-commands");
const { detail } = load(
  path.join(root, "src/help"),
) as typeof import("../src/composition/library-help");
const cad = load(
  path.join(root, "src/cad"),
) as typeof import("../src/composition/cad-execution");
function get<T>(values: Readonly<Record<string, T>>, key: string): T {
  const value = values[key];
  assert(value, `Missing ${key}`);
  return value;
}
const declaration = (key: string) => get(catalog, key);
const contractFor = (key: string) => get(contracts, key);
function member(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}
function helpFor(key: string): string {
  const [first, ...rest] = key.split(" ");
  assert(first);
  return detail(first, ...rest);
}

test("one declaration projects identical CLI/help/MCP schemas, requirements and aliases", () => {
  const publicOperations = Object.keys(catalog)
    .filter((operation) => !declaration(operation).internalOnly)
    .sort();
  assert.deepEqual(
    commands
      .filter((command) => command.kind === "cad")
      .map((command) => command.target)
      .sort(),
    publicOperations,
  );
  assert.deepEqual(
    mcpTools.map((tool) => tool._meta.fmcad.operation).sort(),
    publicOperations,
  );
  assert.equal(byMcpName.size, publicOperations.length);
  assert.equal(cad.validateCad, validateCad);
  for (const command of commands.filter((command) => command.kind === "cad")) {
    assert(command.target);
    const contract = command.contract;
    assert(contract);
    const tool = mcpTools.find(
      (tool) => tool._meta.fmcad.operation === command.target,
    );
    assert(tool);
    assert.deepEqual(tool.inputSchema.properties.data, contract.schema);
    assert.deepEqual(tool._meta.fmcad.requirements, contract.requirements);
    assert.equal(contract.declaration, declaration(command.target));
    assert.equal(command.requiresDoc, contract.requirements.document);
    assert.deepEqual(
      contract.schema.required,
      declaration(command.target).required,
    );
    assert.deepEqual(
      Object.keys(contract.schema.properties),
      Object.keys(declaration(command.target).inputs),
    );
    assert.equal(tool._meta.fmcad.readOnlyEnforced, false);
    assert.equal(
      tool.annotations.readOnlyHint,
      declaration(command.target).readOnly,
    );
    assert.match(
      helpFor(command.key),
      /Neither capability nor successful execution certifies geometry or cloud access/,
    );
    for (const alias of [command.key, ...contract.cli.aliases])
      assert.equal(findCommand(alias.split(" ")), command);
  }
  assert.equal(byMcpName.has("fmcad_cad_document_save_native"), false);
  assert.equal(
    mcpTools.some((tool) => /keychain/.test(tool.name)),
    false,
  );
});

test("negative outer-schema cases fail through the same validator for every operation", () => {
  for (const [operation, entry] of Object.entries(catalog)) {
    for (const invalid of [null, [], "object", 1, false])
      assert.throws(
        () => validateCad(operation, invalid),
        /CAD data must be an object/,
      );
    assert.throws(
      () => validateCad(operation, { ...entry.example, _notAnInput: true }),
      /Unknown CAD inputs/,
    );
    for (const key of entry.required) {
      const data = { ...entry.example };
      delete data[key];
      assert.throws(() => validateCad(operation, data), /Missing CAD inputs/);
    }
  }
  assert.throws(
    () => validateCad("missing.operation", {}),
    /Unknown CAD operation/,
  );
  assert.throws(
    () =>
      validateCad("curve.inspect", {
        ...declaration("curve.inspect").example,
        schemaVersion: "1",
      }),
    /schemaVersion/,
  );
  assert.throws(
    () =>
      validateCad("batch.reconcile", {
        reportPath: "report",
        operations: [{ operation: "check", data: {}, extra: true }],
      }),
    /at most 100/,
  );
});

test("core rejects malformed declarations, missing services and alias collisions offline", () => {
  const entry = {
    summary: "Test",
    inputs: {},
    required: [],
    example: {},
    limitations: [],
    readOnly: true,
  };
  assert.throws(
    () =>
      createOperationCatalog(
        { "test.op": { ...entry, required: ["missing"] } },
        { services: {} },
      ),
    /Invalid CAD declaration/,
  );
  assert.throws(
    () =>
      createOperationCatalog(
        { "test.op": { ...entry, nodeOnly: true } },
        { services: {} },
      ),
    /Missing CAD service/,
  );
  assert.throws(
    () =>
      createOperationCatalog(
        { "model.test": entry, test: entry },
        { services: {} },
      ),
    /Duplicate CAD spelling/,
  );
  assert.throws(
    () =>
      createOperationCatalog(
        { "test.op": entry },
        { services: {}, reservedCliKeys: ["cad test op"] },
      ),
    /Duplicate CAD spelling/,
  );
  let called = 0;
  const shared = createOperationCatalog(
    { "test.op": entry },
    {
      services: {},
      validators: [
        () => {
          called++;
        },
      ],
    },
  );
  shared.validate("test.op", {});
  assert.equal(called, 1);
  assert.equal(
    projectMcpTools(shared.contracts)[0]!.inputSchema.properties.data,
    get(shared.contracts, "test.op").schema,
  );
  assert.throws(
    () =>
      indexCommandRoutes([
        { key: "local", aliases: ["alias"] },
        { key: "alias" },
      ]),
    /Duplicate command spelling/,
  );
  const routes = [
    { key: "local" },
    { key: "local inspect", aliases: ["inspect"] },
  ];
  const lookup = indexCommandRoutes(routes);
  assert.equal(lookup(["local", "inspect", "--json"]), routes[1]);
  assert.equal(lookup(["inspect"]), routes[1]);
  assert.equal(lookup(["unknown"]), undefined);
});

test("MCP invocation adaptation produces typed application input and matching broker guard metadata", () => {
  for (const tool of mcpTools) {
    const operation = tool._meta.fmcad.operation;
    const input = {
      data: declaration(operation).example,
      doc: "Model",
      preview: true,
      purpose: "Inspect contract",
      ...(operation === "capabilities.probe" ||
      declaration(operation).documentPin
        ? {
            docId:
              member(
                member(
                  member(declaration(operation).example, "scope"),
                  "document",
                ),
                "creationId",
              ) || "creation-id",
          }
        : {}),
    };
    const invocation = mcpInvocation(tool.name, input);
    assert.equal(invocation.operation, operation);
    assert.equal(invocation.invocation.operation, operation);
    assert.deepEqual(invocation.invocation.data, input.data);
    const command = findCommand(invocation.argv);
    assert(command);
    assert.equal(command.target, operation);
    assert.ok(invocation.argv.includes("--preview"));
  }
  const name = "fmcad_cad_entity_list";
  for (const args of [
    null,
    [],
    { data: {}, extra: true },
    { data: {} },
    { data: {}, doc: 5 },
    { data: {}, doc: "Model", preview: "true" },
    { data: {}, doc: "Model", purpose: "bad\nmetadata" },
  ]) {
    assert.throws(() => mcpInvocation(name, args));
  }
  assert.throws(
    () => mcpInvocation("fusion_mcp_update", {}),
    /Unknown catalog MCP tool/,
  );
  assert.throws(
    () =>
      mcpInvocation("fmcad_cad_batch_summary", {
        data: { reportPath: "report" },
        docId: "pin",
      }),
    /pins require doc/,
  );
});

test("local requirements and coordinator bindings are explicit, not capability claims", async () => {
  for (const operation of [
    "batch.summary",
    "batch.validate",
    "batch.preview",
    "definition.inspect",
    "definition.expand",
    "reference.layout",
    "drawing.check",
  ]) {
    assert.equal(contractFor(operation).requirements.sdk, "none", operation);
    assert.equal(contractFor(operation).service.kind, "local", operation);
  }
  assert.equal(contractFor("document.status").service.kind, "python");
  assert.equal(
    contractFor("document.save.once").service.handler,
    "document-publication",
  );
  assert.deepEqual(contractFor("ui.inspect").requirements.backends, ["addin"]);
  for (const contract of Object.values(contracts)) {
    assert.equal(contract.requirements.cloudAccess, "not-implied");
    assert.equal(contract.requirements.purpose, "optional");
  }
  assert.equal(
    contractFor("document.save.once").requirements.cloud,
    "required",
  );
  assert.equal(contractFor("batch.summary").requirements.cloud, "none");
  assert.equal(contractFor("document.status").requirements.cloud, "unknown");
  const result = await cad.executeCad(
    null,
    "definition.inspect",
    declaration("definition.inspect").example,
    {},
  );
  assert.equal(result["success"], true);
});
