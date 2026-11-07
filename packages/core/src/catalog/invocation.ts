import type { JsonValue } from "../domain/contracts";

/** Versioned application input, not shell arguments or a physical SDK request. */
export interface CatalogInvocation {
  version: 1;
  kind: "cad";
  operation: string;
  data: Record<string, JsonValue>;
  doc?: string;
  docId?: string;
  docFileId?: string;
  component?: string;
  projectId?: string;
  purpose?: string;
  preview?: boolean;
}

export function decodeCatalogInvocation(value: unknown): CatalogInvocation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Catalog invocation must be an object");
  const input = value as Record<string, unknown>;
  const keys = [
    "version",
    "kind",
    "operation",
    "data",
    "doc",
    "docId",
    "docFileId",
    "component",
    "projectId",
    "purpose",
    "preview",
  ];
  if (
    Object.keys(input).some((key) => !keys.includes(key)) ||
    input["version"] !== 1 ||
    input["kind"] !== "cad" ||
    typeof input["operation"] !== "string"
  )
    throw new Error("Invalid catalog invocation version, kind or fields");
  if (
    !input["data"] ||
    typeof input["data"] !== "object" ||
    Array.isArray(input["data"])
  )
    throw new Error("CAD data must be an object");
  function json(node: unknown, parents: Set<object>): void {
    if (
      node === null ||
      typeof node === "string" ||
      typeof node === "boolean" ||
      (typeof node === "number" && Number.isFinite(node))
    )
      return;
    if (
      !node ||
      typeof node !== "object" ||
      parents.has(node) ||
      (!Array.isArray(node) &&
        ![Object.prototype, null].includes(
          Object.getPrototypeOf(node) as object | null,
        ))
    )
      throw new Error("Catalog data must be acyclic JSON");
    parents.add(node);
    for (const child of Object.values(node)) json(child, parents);
    parents.delete(node);
  }
  json(input["data"], new Set());
  for (const key of ["doc", "docId", "docFileId", "component", "projectId"]) {
    if (
      Object.hasOwn(input, key) &&
      (typeof input[key] !== "string" ||
        !input[key].trim() ||
        input[key].startsWith("--"))
    )
      throw new Error(key + " must be a nonempty string");
  }
  for (const key of ["docId", "docFileId"]) {
    if (
      typeof input[key] === "string" &&
      (/\s/.test(input[key]) || input[key].startsWith("-"))
    )
      throw new Error(key + " must be an identity without whitespace");
  }
  if (
    (Object.hasOwn(input, "docId") || Object.hasOwn(input, "docFileId")) &&
    !input["doc"]
  )
    throw new Error("Document pins require doc");
  if (Object.hasOwn(input, "preview") && typeof input["preview"] !== "boolean")
    throw new Error("preview must be boolean");
  if (
    Object.hasOwn(input, "purpose") &&
    (typeof input["purpose"] !== "string" ||
      Array.from(input["purpose"]).length > 1000 ||
      /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(input["purpose"]))
  )
    throw new Error(
      "purpose requires at most 1000 Unicode characters without control characters",
    );
  return input as unknown as CatalogInvocation;
}

/** Compatibility metadata for the existing broker's document/route guards.
 * Never parsed to execute a catalog operation; the worker consumes the DTO. */
export function catalogPolicyArguments(input: CatalogInvocation): string[] {
  const args = ["cad", ...input.operation.split(".")];
  for (const [key, flag] of [
    ["doc", "--doc"],
    ["docId", "--doc-id"],
    ["docFileId", "--doc-file-id"],
  ] as const) {
    if (input[key] !== undefined) args.push(flag, input[key]);
  }
  if (input.preview) args.push("--preview");
  return args;
}
