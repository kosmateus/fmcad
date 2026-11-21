const operations = new Set(["geometry.delta", "geometry.compare-region"]);
const refFields = new Set([
  "token",
  "kind",
  "name",
  "component",
  "occurrence",
  "path",
  "sketch",
  "index",
  "loopCount",
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(label + " must be an object");
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
) {
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error(label + " has missing or unsupported fields");
}

function reference(value: unknown, label: string, kind = "body") {
  if (typeof value === "string" && value.trim()) return;
  const input = object(value, label);
  if (
    Object.keys(input).some((key) => !refFields.has(key)) ||
    (typeof input["token"] !== "string" && typeof input["name"] !== "string") ||
    (input["kind"] !== undefined && input["kind"] !== kind) ||
    (input["token"] !== undefined && !input["token"]) ||
    (input["name"] !== undefined && !input["name"])
  ) {
    throw new Error(label + " must be an explicit entity reference");
  }
}

function mask(value: unknown, label: string) {
  const input = object(value, label);
  exactKeys(input, ["include", "exclude"], ["include"], label);
  for (const part of ["include", "exclude"]) {
    if (input[part] === undefined && part === "exclude") continue;
    if (!Array.isArray(input[part]) || input[part].length > 1000)
      throw new Error(
        label + "." + part + " must be an array of at most 1000 solid refs",
      );
    input[part].forEach((item, index) =>
      reference(item, label + "." + part + "[" + index + "]"),
    );
  }
}

/** The catalog validates the outer record; this policy checks its unknown fields. */
function validate(operation: string, data: Record<string, unknown>) {
  if (!operations.has(operation)) return;
  const required =
    operation === "geometry.compare-region"
      ? ["before", "after", "frame", "allowed"]
      : ["before", "after", "frame"];
  const optional = [
    "allowed",
    "protected",
    "operationBudget",
    "timeBudgetMs",
    "schemaVersion",
  ];
  exactKeys(data, [...required, ...optional], required, operation);
  if (data["schemaVersion"] !== undefined && data["schemaVersion"] !== 1)
    throw new Error("schemaVersion must be 1");
  reference(data["before"], "before");
  reference(data["after"], "after");
  const frame = object(data["frame"], "frame");
  exactKeys(frame, ["space", "component"], ["space", "component"], "frame");
  if (!new Set<unknown>(["assembly", "component local"]).has(frame["space"]))
    throw new Error("frame.space must be assembly or component local");
  reference(frame["component"], "frame.component", "component");
  for (const field of ["allowed", "protected"]) {
    if (data[field] !== undefined) mask(data[field], field);
  }
  for (const [field, defaultValue, maximum] of [
    ["operationBudget", 256, 10000],
    ["timeBudgetMs", 10000, 300000],
  ] as const) {
    const value = data[field] === undefined ? defaultValue : data[field];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > maximum
    )
      throw new Error(field + " must be an integer from 1 to " + maximum);
  }
}

export { validate };
