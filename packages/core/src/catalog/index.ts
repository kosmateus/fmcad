/** Pure operation contract. Hosts supply declarations and specialist validators,
 * never a second schema/alias/dispatch table. Descriptions are not parsed as a DSL. */
export * from "./invocation";
export * from "./capabilities";
export * from "./capability-probe";
export interface OperationDeclaration {
  summary: string;
  inputs: Record<string, string>;
  required: string[];
  example: Record<string, unknown>;
  limitations: string[];
  readOnly: boolean;
  requiresDoc?: boolean;
  internalOnly?: boolean;
  nodeOnly?: boolean;
  offline?: boolean;
  batchMode?: string;
  definitionMode?: string;
  dataImport?: boolean;
  /** Requires a stable SDK and durable baseline identity. */
  documentPin?: boolean;
  [extension: string]: unknown;
}

export interface ObjectSchema {
  type: "object";
  properties: Record<string, { description: string }>;
  required: string[];
  additionalProperties: false;
}

export interface OperationContract {
  operation: string;
  declaration: OperationDeclaration;
  schema: ObjectSchema;
  cli: { key: string; aliases: string[] };
  service: { kind: "local" | "coordinator" | "python"; handler: string };
  requirements: {
    document: boolean;
    purpose: "optional";
    sdk: "none" | "required" | "conditional";
    cloud: "none" | "required" | "conditional" | "unknown";
    cloudAccess: "not-implied";
    backends: readonly ("mcp" | "addin")[];
  };
  readOnlyRequested: boolean;
  readOnlyEnforced: false;
}

export type SpecialistValidator = (
  operation: string,
  data: Record<string, unknown>,
) => void;

export interface CatalogOptions {
  reservedCliKeys?: readonly string[];
  validators?: readonly SpecialistValidator[];
  /** Every Node coordinator/local operation must have a registered service. */
  services: Readonly<Record<string, string>>;
}

export interface CommandRoute {
  key: string;
  aliases?: readonly string[];
}

/** Shared longest-route lookup for every retained CLI command, including local
 * and legacy routes. Duplicate aliases are errors, never last-writer wins. */
export function indexCommandRoutes<T extends CommandRoute>(
  routes: readonly T[],
) {
  const byKey = new Map<string, T>();
  for (const route of routes) {
    for (const spelling of [route.key, ...(route.aliases ?? [])]) {
      if (byKey.has(spelling))
        throw new Error("Duplicate command spelling: " + spelling);
      byKey.set(spelling, route);
    }
  }
  return (argv: readonly string[]): T | undefined => {
    for (let length = argv.length; length > 0; length--) {
      const entry = byKey.get(argv.slice(0, length).join(" "));
      if (entry) return entry;
    }
    return undefined;
  };
}

export function createOperationCatalog(
  declarations: Readonly<Record<string, OperationDeclaration>>,
  options: CatalogOptions,
) {
  const contracts: Record<string, OperationContract> = Object.create(
    null,
  ) as Record<string, OperationContract>;
  const spellings = new Map<string, string>();
  const reserved = new Set(options.reservedCliKeys ?? []);
  for (const [operation, declaration] of Object.entries(declarations)) {
    if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/.test(operation)) {
      throw new Error("Invalid CAD operation: " + operation);
    }
    if (
      typeof declaration.summary !== "string" ||
      typeof declaration.readOnly !== "boolean" ||
      !Array.isArray(declaration.required) ||
      new Set(declaration.required).size !== declaration.required.length ||
      declaration.required.some(
        (key) => !Object.hasOwn(declaration.inputs, key),
      ) ||
      Object.values(declaration.inputs).some(
        (value) => typeof value !== "string",
      )
    ) {
      throw new Error("Invalid CAD declaration: " + operation);
    }
    const base = operation.replaceAll(".", " ");
    const key = reserved.has(base) ? "cad " + base : base;
    const aliases = [
      ...(key.startsWith("cad ") ? [] : ["cad " + base]),
      ...(operation.startsWith("model.") && operation !== "model.thread"
        ? [operation.slice(6)]
        : []),
      ...(operation === "document.save_as" ? ["doc save-as"] : []),
      ...(operation === "document.status" ? ["doc status"] : []),
    ];
    if (!declaration.internalOnly) {
      for (const spelling of [key, ...aliases]) {
        if (spellings.has(spelling) || reserved.has(spelling)) {
          throw new Error("Duplicate CAD spelling: " + spelling);
        }
        spellings.set(spelling, operation);
      }
    }
    const local =
      declaration.offline === true ||
      declaration.definitionMode !== undefined ||
      ["validate", "preview"].includes(declaration.batchMode ?? "");
    const service = declaration.nodeOnly
      ? options.services[operation]
      : operation;
    if (!service) throw new Error("Missing CAD service: " + operation);
    contracts[operation] = {
      operation,
      declaration,
      schema: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(declaration.inputs).map(([name, description]) => [
            name,
            { description },
          ]),
        ),
        required: [...declaration.required],
        additionalProperties: false,
      },
      cli: { key, aliases },
      service: {
        kind: local ? "local" : declaration.nodeOnly ? "coordinator" : "python",
        handler: service,
      },
      requirements: {
        document: declaration.requiresDoc !== false,
        purpose: "optional",
        sdk: local
          ? "none"
          : declaration.dataImport ||
              ["definition.instantiate", "references.refresh"].includes(
                operation,
              )
            ? "conditional"
            : "required",
        cloud: local
          ? "none"
          : [
                "document.save_as",
                "document.save.once",
                "document.save.observe",
              ].includes(operation)
            ? "required"
            : ["component.externalize", "references.refresh"].includes(
                  operation,
                )
              ? "conditional"
              : "unknown",
        cloudAccess: "not-implied",
        backends: local
          ? []
          : [
                "batch.reconcile",
                "batch.finalize",
                "ui.inspect",
                "ui.respond",
                "ui.resolve",
              ].includes(operation)
            ? ["addin"]
            : ["mcp", "addin"],
      },
      readOnlyRequested: declaration.readOnly,
      readOnlyEnforced: false,
    };
  }
  function validate(operation: string, value: unknown): OperationDeclaration {
    const contract = contracts[operation];
    if (!contract) throw new Error("Unknown CAD operation: " + operation);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("CAD data must be an object");
    }
    const data = value as Record<string, unknown>;
    const missing = contract.schema.required.filter(
      (key) => !Object.hasOwn(data, key),
    );
    if (missing.length)
      throw new Error("Missing CAD inputs: " + missing.join(", "));
    const unknown = Object.keys(data).filter(
      (key) => !Object.hasOwn(contract.schema.properties, key),
    );
    if (unknown.length)
      throw new Error("Unknown CAD inputs: " + unknown.join(", "));
    for (const validator of options.validators ?? [])
      validator(operation, data);
    return contract.declaration;
  }
  return { contracts, validate };
}

/** Local discovery, independent of physical backend schemas and SDK availability.
 * Nested restrictions remain in the shared specialist validator, not invented
 * from prose. Neither annotations nor readOnlyRequested promise a sandbox. */
export function projectMcpTools(
  contracts: Readonly<Record<string, OperationContract>>,
) {
  return Object.values(contracts)
    .filter((contract) => !contract.declaration.internalOnly)
    .map((contract) => ({
      name:
        "fmcad_cad_" +
        contract.operation.replaceAll(".", "_").replaceAll("-", "_"),
      description: contract.declaration.summary,
      inputSchema: {
        type: "object" as const,
        properties: {
          data: contract.schema,
          doc: { type: "string", minLength: 1 },
          docId: { type: "string", minLength: 1 },
          docFileId: { type: "string", minLength: 1 },
          component: { type: "string", minLength: 1 },
          projectId: { type: "string", minLength: 1 },
          purpose: { type: "string", maxLength: 1000 },
          preview: { type: "boolean" },
        },
        required: ["data", ...(contract.requirements.document ? ["doc"] : [])],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: contract.readOnlyRequested },
      _meta: {
        fmcad: {
          operation: contract.operation,
          requirements: contract.requirements,
          service: contract.service,
          readOnlyRequested: contract.readOnlyRequested,
          readOnlyEnforced: contract.readOnlyEnforced,
          validation:
            "outer-schema-and-specialist-preflight; not geometry proof",
        },
      },
    }));
}
