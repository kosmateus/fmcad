import { record } from "./contracts";
import { canonical, clone, referenceParts, transform } from "./json";
import { expandDefinition } from "./definition";

export const limitations = [
  "Offline checks cover outer operation keys/required fields and step/reference structure only; nested schemas/types, conditional fields, units, geometry, entity existence, solver behavior and output reference paths are not verified.",
  "No rollback. Exceptions and unsuccessful mutations may have changed Fusion; inspect before any new run.",
  "Replay trusts local successful reports, not current model state. CAD CLI --doc accepts open-document names, not file IDs; use doc status to compare actual identity separately. Name-based replay cannot detect document replacement.",
  "reportPath is a local directory of immutable JSON snapshots. Stale locks require operator inspection; do not use network filesystems.",
];
export interface BatchDeclaration {
  required?: readonly string[];
  inputs?: Readonly<Record<string, unknown>>;
  readOnly?: boolean;
  nodeOnly?: boolean;
  offline?: boolean;
  batchAllowed?: boolean;
  nonTransactional?: boolean;
}
export type BatchCatalog = Readonly<Record<string, BatchDeclaration>>;
export interface BatchStep {
  id: string;
  operation: string;
  data: Record<string, unknown>;
  component?: unknown;
  onExisting?: string;
  expectFail?: boolean;
}
export interface BatchPlan {
  steps: number;
  backendCalls: number;
  timeBudgetMs: number | null;
  mutations: number;
  [key: string]: unknown;
}
export interface BatchValidation {
  success: boolean;
  errors: string[];
  limitations: string[];
  atomic: { requested: unknown; effective: unknown };
  operations?: BatchStep[];
  exports?: unknown;
  recipe?: Record<string, unknown>;
  plan?: BatchPlan;
  checks?: string[];
}
export function validateBatchMode(data: Record<string, unknown>): void {
  const mode = data["mode"];
  if (
    Object.hasOwn(data, "mode") &&
    mode !== "validate" &&
    mode !== "preview" &&
    mode !== "run"
  )
    throw new Error("mode must be validate, preview, or run");
}
export function atomicInfo(data: unknown): {
  requested: unknown;
  effective: unknown;
} {
  const requested =
    record(data) && Object.hasOwn(data, "atomic") ? data["atomic"] : undefined;
  return { requested, effective: requested === undefined ? true : requested };
}
export const ATOMIC_BACKENDS = { addin: true, mcp: false } as const;
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export function validateBatch(
  data: unknown,
  catalog: BatchCatalog,
  isLocal: (operation: string) => boolean,
): BatchValidation {
  const errors: string[] = [];
  let input: Record<string, unknown>;
  try {
    if (record(data)) validateBatchMode(data);
    if (
      record(data) &&
      (Object.hasOwn(data, "exports") || Object.hasOwn(data, "expansion"))
    )
      throw new Error(
        "exports and expansion are result-only fields; use outputs",
      );
    input = expandDefinition(data);
  } catch (error) {
    return {
      success: false,
      errors: [errorMessage(error)],
      limitations: [...limitations],
      atomic: atomicInfo(data),
    };
  }
  for (const key of Object.keys(input))
    if (
      ![
        "operations",
        "runId",
        "reportPath",
        "mode",
        "parameters",
        "exports",
        "expansion",
        "recipe",
        "timeBudgetMs",
        "atomic",
      ].includes(key)
    )
      errors.push(`Unknown batch field: ${key}`);
  if (Object.hasOwn(input, "atomic") && typeof input["atomic"] !== "boolean")
    errors.push(
      "atomic must be a boolean: true for atomic (default) or false for non-atomic",
    );
  const budget = input["timeBudgetMs"],
    runId = input["runId"],
    reportPath = input["reportPath"];
  if (
    Object.hasOwn(input, "timeBudgetMs") &&
    (typeof budget !== "number" || !Number.isSafeInteger(budget) || budget < 1)
  )
    errors.push("timeBudgetMs must be a positive safe integer");
  if (typeof runId !== "string" || !/^[A-Za-z0-9_-]+$/.test(runId))
    errors.push(
      "runId must contain only letters, digits, underscores, or hyphens",
    );
  if (
    reportPath !== undefined &&
    (typeof reportPath !== "string" || !reportPath.trim())
  )
    errors.push("reportPath must be a nonempty directory path");
  if (!Array.isArray(input["operations"]) || !input["operations"].length)
    errors.push("operations must be a nonempty array");
  const steps: unknown[] = Array.isArray(input["operations"])
    ? input["operations"]
    : [];
  const recipe = input["recipe"];
  const parameters = record(input["parameters"]) ? input["parameters"] : {};
  if (recipe !== undefined) {
    if (
      !record(recipe) ||
      Object.keys(recipe).some((key) => !["id", "bindings"].includes(key)) ||
      typeof recipe["id"] !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(recipe["id"]) ||
      !Array.isArray(recipe["bindings"]) ||
      !recipe["bindings"].length
    )
      errors.push("recipe requires id and nonempty bindings");
    else
      for (const binding of recipe["bindings"]) {
        if (
          !record(binding) ||
          Object.keys(binding).some(
            (key) =>
              !["parameter", "target", "name", "role", "input"].includes(key),
          ) ||
          typeof binding["parameter"] !== "string" ||
          !Object.hasOwn(parameters, binding["parameter"]) ||
          !record(binding["target"]) ||
          typeof binding["target"]["$ref"] !== "string" ||
          typeof binding["input"] !== "string" ||
          (typeof binding["name"] !== "string" &&
            typeof binding["role"] !== "string")
        )
          errors.push(
            "Invalid recipe binding: parameter, input, target $ref and name or role required",
          );
      }
  }
  const ids = new Map<unknown, number>();
  steps.forEach((step, index) => {
    if (!record(step)) {
      errors.push(`Step ${index} must be an object`);
      return;
    }
    const id = step["id"];
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(id) ||
      ["__proto__", "constructor", "prototype"].includes(id)
    )
      errors.push(`Invalid step id at ${index}`);
    if (ids.has(id)) errors.push(`Duplicate step id: ${String(id)}`);
    ids.set(id, index);
  });
  const dependencies: number[][] = steps.map(() => []);
  steps.forEach((step, index) => {
    if (!record(step)) return;
    const id = String(step["id"]),
      operation = String(step["operation"]),
      payload = step["data"];
    for (const key of Object.keys(step))
      if (
        ![
          "id",
          "operation",
          "data",
          "component",
          "onExisting",
          "expectFail",
        ].includes(key)
      )
        errors.push(`Unknown step field: ${id}.${key}`);
    if (
      step["onExisting"] !== undefined &&
      step["onExisting"] !== "error" &&
      step["onExisting"] !== "reuse"
    )
      errors.push(`Invalid onExisting for ${id}`);
    if (
      step["expectFail"] !== undefined &&
      typeof step["expectFail"] !== "boolean"
    )
      errors.push(`Invalid expectFail for ${id}`);
    const spec = Object.hasOwn(catalog, operation)
      ? catalog[operation]
      : undefined;
    if (
      step["expectFail"] === true &&
      !(spec?.readOnly === true || isLocal(operation))
    )
      errors.push(`expectFail requires a read-only operation: ${id}`);
    if (
      (!spec && !isLocal(operation)) ||
      spec?.nodeOnly ||
      /^(batch\.|definition\.)/.test(operation)
    )
      errors.push(`Unknown or non-CAD operation: ${operation}`);
    if (spec?.batchAllowed === false)
      errors.push(
        `Operation must be invoked separately, not in a modeling batch: ${operation}`,
      );
    if (!record(payload)) errors.push(`data must be an object for ${id}`);
    else if (spec) {
      for (const field of spec.required || [])
        if (!Object.hasOwn(payload, field) || payload[field] === null)
          errors.push(`Missing required field: ${id}.${field}`);
      if (spec.inputs)
        for (const field of Object.keys(payload))
          if (
            !Object.hasOwn(spec.inputs, field) &&
            !(spec.required || []).includes(field)
          )
            errors.push(`Unknown input field: ${id}.${field}`);
    }
    try {
      transform(step, "$param", (name) => {
        throw new Error(`Unresolved parameter: ${name}`);
      });
      for (const marker of ["$input", "$local"])
        transform(step, marker, (name) => {
          throw new Error(`Unresolved ${marker}: ${name}`);
        });
      transform(step, "$ref", (reference) => {
        const refId = referenceParts(reference)[0];
        const dependency = ids.get(refId);
        if (dependency === undefined)
          errors.push(`Unknown reference: ${reference}`);
        else {
          dependencies[index]!.push(dependency);
          if (dependency >= index)
            errors.push(`Future or self reference: ${reference}`);
        }
        return null;
      });
    } catch (error) {
      errors.push(errorMessage(error));
    }
  });
  const visiting = new Set<number>(),
    visited = new Set<number>();
  function visit(index: number): void {
    if (visiting.has(index)) {
      errors.push(
        `Reference cycle at step ${String((steps[index] as Record<string, unknown>)["id"])}`,
      );
      return;
    }
    if (visited.has(index)) return;
    visiting.add(index);
    for (const dependency of dependencies[index]!) visit(dependency);
    visiting.delete(index);
    visited.add(index);
  }
  steps.forEach((_, index) => visit(index));
  try {
    transform(input["exports"] ?? {}, "$ref", (reference) => {
      if (!ids.has(referenceParts(reference)[0]))
        throw new Error(`Unknown exported reference: ${reference}`);
      return null;
    });
    if (record(recipe) && !errors.length)
      validateRecipe(
        recipe,
        parameters,
        steps as Record<string, unknown>[],
        ids,
        data,
      );
  } catch (error) {
    errors.push(errorMessage(error));
  }
  return {
    success: errors.length === 0,
    errors,
    operations: steps as BatchStep[],
    exports: input["exports"] ?? {},
    ...(record(recipe) ? { recipe } : {}),
    atomic: atomicInfo(data),
    plan: {
      steps: steps.length,
      backendCalls: steps.length + (recipe ? 2 : 0),
      timeBudgetMs: (budget ??
        (record(data) && data["formatVersion"] === 1 ? 180000 : null)) as
        number | null,
      mutations: steps.filter(
        (step) =>
          !record(step) ||
          !(
            catalog[String(step["operation"])]?.readOnly === true ||
            isLocal(String(step["operation"]))
          ),
      ).length,
      ...(record(input["expansion"]) ? input["expansion"] : {}),
    },
    checks: [
      "JSON structure",
      "known operations",
      "required and known input fields",
      "unique IDs",
      "reference syntax and ordering",
      "reference cycles",
      "parameter substitution",
    ],
    limitations: [...limitations],
  };
}
function validateRecipe(
  recipe: Record<string, unknown>,
  parameters: Record<string, unknown>,
  steps: Record<string, unknown>[],
  ids: Map<unknown, number>,
  data: unknown,
): void {
  const bindings = recipe["bindings"] as Record<string, unknown>[];
  for (const binding of bindings) {
    const reference = (binding["target"] as Record<string, string>)["$ref"]!;
    if (!ids.has(referenceParts(reference)[0]))
      throw new Error(`Unknown binding target: ${reference}`);
    if (typeof parameters[String(binding["parameter"])] !== "string")
      throw new Error("Bound recipe parameters must be expression strings");
  }
  for (const name of new Set(
    bindings.map((binding) => String(binding["parameter"])),
  )) {
    const probe = clone(data) as Record<string, unknown>;
    (probe["parameters"] as Record<string, unknown>)[name] =
      "__fmcad_binding_probe__";
    const expanded = expandDefinition(probe)["operations"] as Record<
      string,
      unknown
    >[];
    if (expanded.length !== steps.length)
      throw new Error("Structural parameter cannot be regenerated");
    const changed: string[] = [];
    function differences(a: unknown, b: unknown, parts: string[]): void {
      if (canonical(a) === canonical(b)) return;
      if (
        (record(a) && record(b)) ||
        (Array.isArray(a) && Array.isArray(b) && a.length === b.length)
      ) {
        if (
          Object.keys(a as object).join("|") !==
          Object.keys(b as object).join("|")
        )
          throw new Error("Structural parameter cannot be regenerated");
        for (const key of Object.keys(a as object))
          differences(
            (a as Record<string, unknown>)[key],
            (b as Record<string, unknown>)[key],
            [...parts, key],
          );
      } else changed.push(parts.join("."));
    }
    steps.forEach((step, index) =>
      differences(step, expanded[index], [String(step["id"])]),
    );
    const declared = bindings
      .filter((binding) => binding["parameter"] === name)
      .map(
        (binding) =>
          `${referenceParts((binding["target"] as Record<string, string>)["$ref"]!)[0]}.data.${String(binding["input"])}`,
      );
    if (
      !changed.length ||
      changed.some((key) => !declared.includes(key)) ||
      declared.some((key) => !changed.includes(key))
    )
      throw new Error(
        `Incomplete or structural regeneration bindings for parameter: ${name}`,
      );
  }
}
