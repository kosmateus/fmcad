import type {
  CatalogInvocation,
  CatalogMcpTool,
  CatalogServices,
  JsonValue,
  OperationContract,
  OperationDeclaration,
} from "../api/contracts";
import { CompatibilityError } from "../api/compatibility";

interface CatalogImplementation {
  contracts: Record<string, OperationContract>;
  mcpTools: CatalogMcpTool[];
  validateInvocation(value: unknown): CatalogInvocation;
  validateCad(
    operation: string,
    data: Record<string, JsonValue>,
  ): OperationDeclaration;
  mcpInvocation(
    name: string,
    args?: unknown,
  ): ReturnType<CatalogServices["fromMcp"]>;
  localInvocation(input: CatalogInvocation): boolean;
}
function catalog(): CatalogImplementation {
  return require("../catalog");
}
function snapshot<T>(value: T): T {
  return structuredClone(value);
}

/** Construction is pure; local declaration providers are loaded only on use. */
export function createCatalogServices(): CatalogServices {
  const validate = (input: CatalogInvocation): CatalogInvocation => {
    if (input?.version !== 1)
      throw new CompatibilityError("dto", input?.version, 1);
    return snapshot(catalog().validateInvocation(snapshot(input)));
  };
  return Object.freeze({
    list: () =>
      snapshot(
        Object.values(catalog().contracts).filter(
          (item) => !item.declaration.internalOnly,
        ),
      ),
    validate,
    validateData(operation: string, data: Record<string, JsonValue>) {
      const declaration = catalog().validateCad(operation, snapshot(data));
      if (declaration.internalOnly)
        throw new Error("Internal CAD operation is not public: " + operation);
      return snapshot(declaration);
    },
    tools: () => snapshot(catalog().mcpTools),
    fromMcp: (name: string, args?: unknown) =>
      snapshot(catalog().mcpInvocation(name, args)),
    isLocal: (input: CatalogInvocation) => catalog().localInvocation(input),
  });
}
