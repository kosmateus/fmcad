import { createRequire } from "node:module";
import type {
  OperationDeclaration,
  CatalogInvocation,
  BrokerSdkProbePort,
  JsonValue,
} from "@fmcad/core";
import { planInspection } from "../../packages/core/src/application/inspection";
const load = createRequire(__filename);
type Payload = Record<string, unknown>;
interface Provider {
  descriptors?: Record<string, OperationDeclaration>;
  configure(catalog: Record<string, OperationDeclaration>): void;
  validate(operation: string, data: Payload): unknown;
  prepare(operation: string, data: Payload): unknown;
  isOffline(operation: string, data: Payload): boolean;
  OPERATIONS: readonly string[];
  operations: readonly string[];
}
interface Specialist {
  validate(operation: string, data: Payload): unknown;
}
interface InternalSpecialist {
  isInternal(operation: string): boolean;
  validateInternal(operation: string, data: unknown): OperationDeclaration;
  authorize(data: unknown): void;
}
function provider(name: string): Provider {
  return load("../../" + name);
}
function specialist(name: string): Specialist {
  return load("../../catalog/" + name);
}

// Node composition of declaration providers and specialist preflight. The pure
// core owns schemas, alias resolution, requirements and service contracts.
import fs from "node:fs";
import path from "node:path";
import {
  createOperationCatalog,
  projectMcpTools,
  decodeCatalogInvocation,
  catalogPolicyArguments,
  inspectCapabilities,
  validateCapabilitySearchInput,
  validateCapabilityProbeInput,
  validateCapabilityProbeIdentity,
  probeCapability,
} from "@fmcad/core";
const modules: Record<string, Provider> = Object.fromEntries(
  [
    "data-import",
    "entity-query",
    "sketch",
    "datum",
    "curve",
    "surface",
    "reference",
    "drawing-package",
    "drawing-check",
    "drawing-export",
    "spring",
    "thread",
    "cam",
    "seal",
    "fastener",
    "feature-rework",
    "ui",
    "references-refresh",
    "document-publication",
    "externalization",
  ].map((name) => [name, provider(name)]),
);
const brepBaseline = specialist("brep-baseline");
const brepBaselineInternal = load(
  "../../catalog/brep-baseline-internal",
) as InternalSpecialist;
const regionalGeometry = specialist("regional-geometry");
const sectionWitness = specialist("section-witness");
const selectionRules = load("../../catalog/selection-rules") as Specialist & {
  RULE_OPERATIONS: readonly string[];
};
export const selectionRulesInternal = load(
  "../../catalog/selection-rules-internal",
) as InternalSpecialist;
export const semanticModelState = specialist("semantic-model-state");
const nativeDrive = specialist("native-drive");
export const catalog: Record<string, OperationDeclaration> = {};
for (const name of [
  "data-import",
  "curve",
  "surface",
  "spring",
  "thread",
  "cam",
  "seal",
  "fastener",
  "drawing-package",
  "drawing-check",
  "drawing-export",
]) {
  Object.assign(catalog, modules[name]!.descriptors);
}
for (const file of fs
  .readdirSync(path.join(__dirname, "../../catalog"))
  .sort()) {
  if (!file.endsWith(".json")) continue;
  for (const [operation, entry] of Object.entries(
    load("../../catalog/" + file) as Record<string, OperationDeclaration>,
  )) {
    if (catalog[operation])
      throw new Error("Duplicate CAD operation: " + operation);
    catalog[operation] = entry;
  }
}
for (const name of ["datum", "surface", "reference", "references-refresh"])
  modules[name]!.configure(catalog);

const services: Record<string, string> = {};
for (const name of [
  "reference",
  "drawing-package",
  "drawing-check",
  "drawing-export",
  "ui",
]) {
  for (const operation of Object.keys(modules[name]!.descriptors || {})) {
    if (catalog[operation]?.nodeOnly) services[operation] = name;
  }
}
for (const operation of modules["document-publication"]!.OPERATIONS)
  services[operation] = "document-publication";
for (const operation of modules["ui"]!.operations) services[operation] = "ui";
Object.assign(services, {
  "component.externalize": "externalization",
  "references.refresh": "references-refresh",
  "batch.summary": "batch-summary",
  "batch.reconcile": "batch-atomic",
  "batch.finalize": "batch-atomic",
  "definition.instantiate": "batch",
  "capabilities.inspect": "capabilities",
  "capabilities.probe": "capabilities",
});
for (const operation of [
  "measure.baseline.capture",
  "measure.baseline.inspect",
  "measure.baseline.compare",
]) {
  services[operation] = "brep-baseline";
}
for (const operation of selectionRules.RULE_OPERATIONS)
  services[operation] = "selection-rules";
for (const [operation, entry] of Object.entries(catalog)) {
  if (entry.batchMode || entry.definitionMode) services[operation] = "batch";
}
function specialistValidation(operation: string, data: Payload): void {
  if (operation === "inspect.pack")
    planInspection(data, operationCatalog.contracts, operationCatalog.validate);
  nativeDrive.validate(operation, data);
  brepBaseline.validate(operation, data);
  regionalGeometry.validate(operation, data);
  sectionWitness.validate(operation, data);
  selectionRules.validate(operation, data);
  semanticModelState.validate(operation, data);
  if (operation === "capabilities.inspect") validateCapabilitySearchInput(data);
  if (operation === "capabilities.probe") validateCapabilityProbeInput(data);
  modules["ui"]!.validate(operation, data);
  (
    load("../../references-refresh") as {
      validate(data: Payload, operation: string): unknown;
    }
  ).validate(data, operation);
  modules["document-publication"]!.validate(operation, data);
  if (operation === "component.externalize")
    (
      load("../../externalization") as { validate(data: Payload): unknown }
    ).validate(data);
  if (
    operation === "batch.reconcile" &&
    data["operations"] !== undefined &&
    (!Array.isArray(data["operations"]) ||
      data["operations"].length > 100 ||
      data["operations"].some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          Array.isArray(item) ||
          Object.keys(item).some(
            (key) => !["operation", "data"].includes(key),
          ) ||
          typeof item.operation !== "string" ||
          !item.data ||
          typeof item.data !== "object" ||
          Array.isArray(item.data),
      ))
  ) {
    throw new Error(
      "batch reconcile operations must be an array of at most 100 {operation,data} objects",
    );
  }
  if (operation === "definition.instantiate")
    (
      load("../../batch") as { validateBatchMode(data: Payload): unknown }
    ).validateBatchMode(data);
  modules["feature-rework"]!.validate(operation, data);
  if (catalog[operation]!.dataImport)
    modules["data-import"]!.prepare(operation, data);
  for (const name of [
    "entity-query",
    "sketch",
    "datum",
    "curve",
    "surface",
    "reference",
    "drawing-package",
    "drawing-check",
    "drawing-export",
    "spring",
    "thread",
    "cam",
    "seal",
    "fastener",
  ]) {
    modules[name]!.validate(operation, data);
  }
}
// Legacy reserved spellings are supplied only when projecting CLI routes. They
// are deliberately not imported here (commands -> catalog must stay acyclic).
const operationCatalog = createOperationCatalog(catalog, {
  services,
  validators: [specialistValidation],
});
export function validateCad(operation: string, data: unknown) {
  if (brepBaselineInternal.isInternal(operation))
    return brepBaselineInternal.validateInternal(operation, data);
  if (selectionRulesInternal.isInternal(operation))
    return selectionRulesInternal.validateInternal(operation, data);
  return operationCatalog.validate(operation, data);
}
export function cliContracts(reservedCliKeys: readonly string[]) {
  return Object.fromEntries(
    Object.entries(
      createOperationCatalog(catalog, { services, reservedCliKeys }).contracts,
    ).filter(([, contract]) => !contract.declaration.internalOnly),
  );
}
export const mcpTools = projectMcpTools(operationCatalog.contracts);
export const byMcpName = new Map(mcpTools.map((tool) => [tool.name, tool]));
if (byMcpName.size !== mcpTools.length)
  throw new Error("Duplicate projected MCP tool name");

// MCP and workers consume the same typed application input. argv is compatibility
// metadata for existing broker route/document guards, never worker execution.
export function mcpInvocation(name: string, args: unknown = {}) {
  const tool = byMcpName.get(name);
  if (!tool) throw new Error("Unknown catalog MCP tool: " + name);
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Catalog MCP arguments must be an object");
  const schema = tool.inputSchema;
  const missing = schema.required.filter((key) => !Object.hasOwn(args, key));
  const unknown = Object.keys(args).filter(
    (key) => !Object.hasOwn(schema.properties, key),
  );
  if (missing.length)
    throw new Error("Missing catalog MCP arguments: " + missing.join(", "));
  if (unknown.length)
    throw new Error("Unknown catalog MCP arguments: " + unknown.join(", "));
  const operation = tool._meta.fmcad.operation;
  const invocation = validateInvocation({
    version: 1,
    kind: "cad",
    operation,
    ...args,
  });
  return { operation, invocation, argv: catalogPolicyArguments(invocation) };
}

export function validateInvocation(value: unknown) {
  const input = decodeCatalogInvocation(value);
  const contract = operationCatalog.contracts[input.operation];
  if (contract?.declaration.internalOnly)
    throw new Error("Internal CAD operation is not public: " + input.operation);
  const entry = operationCatalog.validate(input.operation, input.data);
  if (entry.requiresDoc !== false && !input.doc)
    throw new Error(input.operation + " requires doc");
  if (entry.dataImport && input.data["inspectModel"] === true && !input.doc)
    throw new Error(input.operation + " with inspectModel requires doc");
  if (
    input.operation === "capabilities.probe" &&
    !input.docId &&
    !input.docFileId
  ) {
    throw new Error(
      "capabilities.probe requires --doc-id or --doc-file-id to pin the target identity",
    );
  }
  if (input.operation === "capabilities.probe") {
    validateCapabilityProbeIdentity({
      docId: input.docId,
      docFileId: input.docFileId,
    });
  }
  if (
    operationCatalog.contracts[input.operation]?.declaration.documentPin &&
    !input.docId &&
    !input.docFileId
  ) {
    throw new Error(
      input.operation +
        " requires --doc-id or --doc-file-id to pin the target document identity",
    );
  }
  if (input.operation === "snapshot.capture_v2") {
    const document = (input.data["scope"] as Record<string, JsonValue>)[
      "document"
    ] as Record<string, JsonValue>;
    if (
      (input.docId && document["creationId"] !== input.docId) ||
      (input.docFileId && document["fileId"] !== input.docFileId)
    ) {
      throw new Error(
        "snapshot.capture_v2 scope.document must match the pinned document identity",
      );
    }
  }
  return input;
}

export function localInvocation(input: CatalogInvocation): boolean {
  const spec = catalog[input.operation]!;
  return !!(
    spec.offline ||
    input.preview ||
    modules["data-import"]!.isOffline(input.operation, input.data) ||
    (input.operation === "references.refresh" &&
      input.data["phase"] === "inspect") ||
    ["validate", "preview"].includes(spec.batchMode!) ||
    (input.operation === "definition.instantiate" &&
      input.data["mode"] &&
      input.data["mode"] !== "run")
  );
}

export function executeCapability(
  operation: string,
  data: unknown,
  context: { docId?: string; docFileId?: string } = {},
  ports: { backend?: string; brokerSdkProbePort?: BrokerSdkProbePort } = {},
) {
  if (operation === "capabilities.inspect")
    // inspectCapabilities performs runtime searchParts validation before using data.
    return inspectCapabilities(
      operationCatalog.contracts,
      data as Parameters<typeof inspectCapabilities>[1],
    );
  if (operation !== "capabilities.probe")
    throw new Error("Unknown capability operation: " + operation);
  validateCapabilityProbeInput(data);
  const target = operationCatalog.contracts[data.capabilityId];
  if (!target || target.declaration.internalOnly) {
    return {
      success: false,
      status: "missing",
      operation,
      result: { capabilityId: data.capabilityId, reason: "notRegistered" },
    };
  }
  if (target.requirements.sdk === "none") {
    return {
      success: false,
      status: "unsupported",
      operation,
      result: { capabilityId: data.capabilityId, reason: "sdkNotRequired" },
    };
  }
  if (!context.docId && !context.docFileId) {
    throw new Error("capabilities.probe requires a pinned document identity");
  }
  const backend = ports.backend;
  if (backend !== "mcp" && backend !== "addin") {
    throw new Error("capabilities.probe requires an explicit selected backend");
  }
  return probeCapability(ports.brokerSdkProbePort!, {
    capabilityId: data.capabilityId,
    backend,
    documentIdentity: {
      ...(context.docId ? { docId: context.docId } : {}),
      ...(context.docFileId ? { docFileId: context.docFileId } : {}),
    },
  }).then((result) => ({
    success: result.status === "pass",
    status: result.status,
    operation,
    result,
  }));
}

export const contracts = operationCatalog.contracts;
export { catalogPolicyArguments };
